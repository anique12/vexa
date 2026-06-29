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

    try {
      let success = false;
      if (this.platform === 'google_meet') {
        success = await this.toggleGoogleMeetMic(true);
      } else if (this.platform === 'teams') {
        success = await this.toggleTeamsMic(true);
      } else if (this.platform === 'zoom') {
        success = await this.toggleZoomMic(true);
      } else {
        log(`[Microphone] Unsupported platform for mic toggle: ${this.platform}`);
        return false;
      }

      if (success) {
        this._isMuted = false;
        log('[Microphone] Unmuted');
        this.startSelfHeal();
      }
      return success;
    } catch (err: any) {
      log(`[Microphone] Unmute failed: ${err.message}`);
      return false;
    }
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
      if (!this._keepUnmuted || this.page.isClosed()) return;
      try {
        if ((await this.isGoogleMeetMicMuted()) === true) {
          await this.toggleGoogleMeetMic(true);
          this._isMuted = false;
          log('[Microphone] Self-heal: platform had muted us externally — re-unmuted');
        }
      } catch {
        /* best-effort; never throw out of the interval */
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
        '[aria-label*="Turn on microphone"]',
        '[aria-label*="Turn off microphone"]',
        'button[aria-label*="microphone"]',
        'button[aria-label*="Microphone"]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (!btn) continue;
        const a = (btn.getAttribute('aria-label') || '').toLowerCase();
        return a.includes('turn on') || a.includes('unmute');
      }
      return null;
    });
  }

  // --- Google Meet ---

  private async toggleGoogleMeetMic(unmute: boolean): Promise<boolean> {
    if (this.page.isClosed()) return false;

    return await this.page.evaluate(async (shouldUnmute: boolean) => {
      // Use specific selectors for bot's own meeting controls (same as join flow)
      // Prioritize "Turn on/off microphone" to avoid matching participant tiles
      const selectors = [
        '[aria-label*="Turn on microphone"]',
        '[aria-label*="Turn off microphone"]',
        'button[aria-label*="Turn on microphone"]',
        'button[aria-label*="Turn off microphone"]',
        'button[aria-label*="microphone"]',
        'button[aria-label*="Microphone"]'
      ];

      for (const sel of selectors) {
        const btn = document.querySelector(sel) as HTMLElement | null;
        if (!btn) continue;

        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const isMuted = ariaLabel.includes('turn on') || ariaLabel.includes('unmute');

        // Click if state doesn't match desired state
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
