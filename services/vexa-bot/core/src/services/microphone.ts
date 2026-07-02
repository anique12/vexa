import { Page } from 'playwright-core';
import { log } from '../utils';

/**
 * MicrophoneService
 *
 * Unified microphone toggle across meeting platforms.
 * The bot's mic is muted by default on join. This service unmutes it
 * when the voice agent needs to speak and re-mutes when done.
 */
export class MicrophoneService {
  private page: Page;
  private platform: string;
  private _isMuted: boolean = true;
  private muteTimerId: NodeJS.Timeout | null = null;
  // Intent: should the mic be kept unmuted? While true, a self-heal loop re-unmutes
  // if the meeting platform mutes the bot externally (Google Meet does this on its
  // own, behind the bot's back — the stale-flag desync that left StewardAI muted).
  private _keepUnmuted: boolean = false;
  private healTimerId: NodeJS.Timeout | null = null;
  // Guards against overlapping self-heal passes (each pass awaits DOM work).
  private _healing: boolean = false;

  constructor(page: Page, platform: string) {
    this.page = page;
    this.platform = platform;
  }

  /**
   * Ensure microphone is unmuted.
   * Returns true if mic is now unmuted, false if toggle failed.
   */
  async unmute(): Promise<boolean> {
    // NOTE: do NOT short-circuit on the internal _isMuted flag. The platform can mute
    // the bot externally without us knowing, so the flag drifts out of sync with the
    // real UI. The toggle* methods read the ACTUAL button state and click only if
    // needed, so always call through to reconcile to reality.
    this.clearMuteTimer();
    this._keepUnmuted = true;

    let success = false;
    try {
      if (this.platform === 'google_meet') {
        // Poll for the mic button — it isn't always mounted the instant mic_on fires.
        success = await this.toggleGoogleMeetMic(true, 5000);
      } else if (this.platform === 'teams') {
        success = await this.toggleTeamsMic(true);
      } else if (this.platform === 'zoom') {
        success = await this.toggleZoomMic(true);
      } else {
        log(`[Microphone] Unsupported platform for mic toggle: ${this.platform}`);
        return false;
      }
    } catch (err: any) {
      log(`[Microphone] Unmute error: ${err.message}`);
    }

    if (success) {
      this._isMuted = false;
      log('[Microphone] Unmuted');
    } else {
      // Don't give up: the button may mount late, or Meet may re-mute us. Self-heal
      // (started below for Google Meet) keeps reconciling until we're truly unmuted.
      log('[Microphone] Unmute not confirmed yet — self-heal will keep retrying');
    }
    // Always run the self-heal loop for Google Meet while we intend to be unmuted,
    // even if the immediate toggle didn't confirm — so a late-mounting button or an
    // external re-mute is corrected instead of leaving the bot silently muted.
    if (this.platform === 'google_meet') this.startSelfHeal();
    return success;
  }

  /**
   * Mute the microphone.
   */
  async mute(): Promise<boolean> {
    // Intentional mute: stop keeping the mic unmuted + stop the self-heal loop so it
    // doesn't fight us. Reconcile to reality (no short-circuit on the stale flag).
    this._keepUnmuted = false;
    this.stopSelfHeal();
    this.clearMuteTimer();

    try {
      let success = false;
      if (this.platform === 'google_meet') {
        success = await this.toggleGoogleMeetMic(false);
      } else if (this.platform === 'teams') {
        success = await this.toggleTeamsMic(false);
      } else if (this.platform === 'zoom') {
        success = await this.toggleZoomMic(false);
      } else {
        return false;
      }

      if (success) {
        this._isMuted = true;
        log('[Microphone] Muted');
      }
      return success;
    } catch (err: any) {
      log(`[Microphone] Mute failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Schedule auto-mute after a delay (for post-speech silence).
   * Cancel with clearMuteTimer() or a new unmute() call.
   */
  scheduleAutoMute(delayMs: number = 2000): void {
    this.clearMuteTimer();
    this.muteTimerId = setTimeout(() => {
      this.mute().catch((err) => {
        log(`[Microphone] Auto-mute failed: ${err.message}`);
      });
    }, delayMs);
  }

  /**
   * Cancel any scheduled auto-mute.
   */
  clearMuteTimer(): void {
    if (this.muteTimerId) {
      clearTimeout(this.muteTimerId);
      this.muteTimerId = null;
    }
  }

  get isMuted(): boolean {
    return this._isMuted;
  }

  /**
   * Self-heal: while we intend to be unmuted (_keepUnmuted), periodically check the
   * REAL Google Meet mic state and re-unmute if the platform muted us externally.
   * Meet mutes participants on its own without telling the bot, which previously
   * left StewardAI silently muted; this reconciles to reality every few seconds.
   * (Google Meet only — the platform whose external auto-mute we observed.)
   */
  private startSelfHeal(): void {
    this.stopSelfHeal();
    if (this.platform !== 'google_meet') return;
    this.healTimerId = setInterval(async () => {
      if (!this._keepUnmuted || this.page.isClosed() || this._healing) return;
      this._healing = true;
      try {
        const muted = await this.isGoogleMeetMicMuted();
        // muted===true  -> Meet muted us externally; re-unmute.
        // muted===null  -> button not found yet (late mount / DOM change); keep trying.
        // muted===false -> already unmuted; nothing to do.
        if (muted === true || muted === null) {
          const ok = await this.toggleGoogleMeetMic(true);
          if (ok) {
            this._isMuted = false;
            log('[Microphone] Self-heal: ensured mic is unmuted');
          }
        }
      } catch {
        /* best-effort; never throw out of the interval */
      } finally {
        this._healing = false;
      }
    }, 3000);
  }

  private stopSelfHeal(): void {
    if (this.healTimerId) {
      clearInterval(this.healTimerId);
      this.healTimerId = null;
    }
  }

  /** Read-only: is the Google Meet mic button currently showing muted? null = unknown. */
  private async isGoogleMeetMicMuted(): Promise<boolean | null> {
    if (this.page.isClosed()) return null;
    return await this.page.evaluate(() => {
      const selectors = [
        'button[aria-label*="Turn on microphone" i]',
        'button[aria-label*="Turn off microphone" i]',
        'button[aria-label*="microphone" i]',
        '[role="button"][aria-label*="microphone" i]',
        '[aria-label*="microphone" i]',
        'div[jsname][data-is-muted]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (!btn) continue;
        const dm = btn.getAttribute('data-is-muted');
        if (dm === 'true') return true;
        if (dm === 'false') return false;
        const a = (btn.getAttribute('aria-label') || '').toLowerCase();
        return a.includes('turn on') || a.includes('unmute');
      }
      return null;
    });
  }

  // --- Google Meet ---

  // maxWaitMs > 0: poll for the mic button to appear (it isn't always mounted the
  // instant mic_on fires ~right after join). 0 = single check (self-heal/mute).
  private async toggleGoogleMeetMic(unmute: boolean, maxWaitMs = 0): Promise<boolean> {
    if (this.page.isClosed()) return false;

    const result = await this.page.evaluate(
      async ({ shouldUnmute, maxWait }: { shouldUnmute: boolean; maxWait: number }) => {
        // Bot's own mic control. `i` = case-insensitive so localized/re-cased labels
        // still match; the "microphone" contains-match tolerates suffixes like
        // "Turn off microphone (⌘ + d)".
        const selectors = [
          'button[aria-label*="Turn on microphone" i]',
          'button[aria-label*="Turn off microphone" i]',
          '[role="button"][aria-label*="Turn on microphone" i]',
          '[role="button"][aria-label*="Turn off microphone" i]',
          'button[aria-label*="microphone" i]',
          '[role="button"][aria-label*="microphone" i]',
          '[aria-label*="microphone" i]',
          'div[jsname][data-is-muted]',
        ];
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const find = (): HTMLElement | null => {
          for (const sel of selectors) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el) return el;
          }
          return null;
        };
        const labelOf = (el: HTMLElement) =>
          (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').toLowerCase();
        const mutedFrom = (el: HTMLElement) => {
          const dm = el.getAttribute('data-is-muted');
          if (dm === 'true') return true;
          if (dm === 'false') return false;
          const l = labelOf(el);
          return l.includes('turn on') || l.includes('unmute');
        };

        // Retry until the control is mounted (or we run out of time).
        let btn = find();
        const deadline = Date.now() + Math.max(0, maxWait);
        while (!btn && Date.now() < deadline) {
          await sleep(250);
          btn = find();
        }
        if (!btn) return { found: false, clicked: false, label: null, mutedAfter: null };

        const before = mutedFrom(btn);
        let clicked = false;
        if ((shouldUnmute && before) || (!shouldUnmute && !before)) {
          btn.click();
          clicked = true;
          await sleep(350); // let Meet flip the button/aria-label
        }
        const after = find();
        const mutedAfter = after ? mutedFrom(after) : before;
        return { found: true, clicked, label: after ? labelOf(after) : labelOf(btn), mutedAfter };
      },
      { shouldUnmute: unmute, maxWait: maxWaitMs }
    );

    log(
      `[Microphone] GoogleMeet toggle(unmute=${unmute}) -> found=${result.found} ` +
        `clicked=${result.clicked} mutedAfter=${result.mutedAfter} label="${result.label ?? ''}"`
    );
    if (!result.found) return false;
    // Success = ended in the desired state (not just "found").
    return unmute ? result.mutedAfter === false : result.mutedAfter === true;
  }

  // --- Zoom Web Client ---

  private async toggleZoomMic(unmute: boolean): Promise<boolean> {
    if (this.page.isClosed()) return false;

    return await this.page.evaluate(async (shouldUnmute: boolean) => {
      // Zoom web client audio button: .join-audio-container__btn
      // When muted: aria-label contains "unmute" or "Unmute"
      // When unmuted: aria-label contains "mute" or "Mute" (but not "unmute")
      const selectors = [
        'button.join-audio-container__btn',
        'button[aria-label*="Mute"]',
        'button[aria-label*="mute"]',
        'button[aria-label*="Unmute"]',
        'button[aria-label*="unmute"]',
      ];

      for (const sel of selectors) {
        const btn = document.querySelector(sel) as HTMLElement | null;
        if (!btn) continue;

        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const isMuted = ariaLabel.includes('unmute');

        if ((shouldUnmute && isMuted) || (!shouldUnmute && !isMuted)) {
          btn.click();
          return true;
        }
        // Already in desired state
        if ((shouldUnmute && !isMuted) || (!shouldUnmute && isMuted)) {
          return true;
        }
      }
      return false;
    }, unmute);
  }

  // --- Microsoft Teams ---

  private async toggleTeamsMic(unmute: boolean): Promise<boolean> {
    if (this.page.isClosed()) return false;

    return await this.page.evaluate(async (shouldUnmute: boolean) => {
      const selectors = [
        '#microphone-button',
        'button[data-tid="toggle-mute"]',
        'button[aria-label*="Mute"]',
        'button[aria-label*="mute"]',
        'button[aria-label*="Unmute"]',
        'button[aria-label*="unmute"]',
        '[role="toolbar"] button[aria-label*="Mic"]',
        '[role="toolbar"] button[aria-label*="mic"]'
      ];

      for (const sel of selectors) {
        const btn = document.querySelector(sel) as HTMLElement | null;
        if (!btn) continue;

        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const isMuted = ariaLabel.includes('unmute') || ariaLabel.includes('turn on');

        if ((shouldUnmute && isMuted) || (!shouldUnmute && !isMuted)) {
          btn.click();
          return true;
        }
        return true;
      }
      return false;
    }, unmute);
  }
}
