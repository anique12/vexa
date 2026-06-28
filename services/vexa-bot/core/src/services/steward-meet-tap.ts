/**
 * steward-meet-tap.ts — Meet/Teams combined-mix audio tap for StewardAI.
 *
 * Additive to Vexa. Sets up ONE combined-meeting-mix AudioContext driving an
 * AudioWorklet (the source string below, == vexa-patch/audioworklet/pcm-worklet.js)
 * that downsamples to 16 kHz mono and emits 20 ms s16le frames. Each frame is
 * bridged to Node via page.exposeFunction('__vexaStewardFrame', ...) and fed to
 * the StewardForwarder, which length-prefixes and ships it to the StewardAI
 * bridge.
 *
 * This is SEPARATE from Vexa's per-speaker capture (index.ts
 * startPerSpeakerAudioCapture). The per-speaker path emits one stream per
 * participant and gates on amplitude > 0.005 (drops silence). StewardAI's
 * STT/VAD want the single combined mix WITH silence preserved for endpointing,
 * so we tap the combined element separately and leave Vexa's diarization path
 * completely untouched.
 *
 * The worklet is loaded via a Blob URL built from the source string inside the
 * page (no static asset server needed — robust inside the bot's sandbox).
 */

import { Page } from "playwright-core";
import { log } from "../utils";
import type { StewardForwarder } from "./steward-forwarder";

/**
 * AudioWorklet processor source. Canonical copy of
 * vexa-patch/audioworklet/pcm-worklet.js (processor only — the integration
 * notes that live at the bottom of that file are intentionally omitted here).
 * Built into a Blob URL in the page and passed to ctx.audioWorklet.addModule().
 */
const STEWARD_WORKLET_SOURCE = `
const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms @ 16 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2; // 640 bytes, s16le

class StewardPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._inRate = sampleRate;
    this._ratio = this._inRate / TARGET_RATE; // input samples per output sample
    this._readPos = 0;
    this._inBuf = new Float32Array(0);
    this._inBufBase = 0;
    this._acc = new Float32Array(FRAME_SAMPLES);
    this._accLen = 0;
    this._enabled = true;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.enabled === "boolean") {
        this._enabled = e.data.enabled;
      }
    };
  }

  _toMono(input) {
    const chCount = input.length;
    if (chCount === 0) return new Float32Array(0);
    const n = input[0].length;
    if (chCount === 1) return input[0];
    const mono = new Float32Array(n);
    for (let c = 0; c < chCount; c++) {
      const ch = input[c];
      for (let i = 0; i < n; i++) mono[i] += ch[i];
    }
    const inv = 1 / chCount;
    for (let i = 0; i < n; i++) mono[i] *= inv;
    return mono;
  }

  _flushFrame() {
    const out = new ArrayBuffer(FRAME_BYTES);
    const view = new DataView(out);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      let s = this._acc[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      view.setInt16(i * 2, v, true);
    }
    this._accLen = 0;
    this.port.postMessage(out, [out]);
  }

  _pushResampled(sample) {
    this._acc[this._accLen++] = sample;
    if (this._accLen === FRAME_SAMPLES) this._flushFrame();
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const mono = this._toMono(input);
    if (mono.length === 0) return true;
    if (!this._enabled) {
      this._inBuf = new Float32Array(0);
      this._inBufBase = 0;
      this._readPos = 0;
      this._accLen = 0;
      return true;
    }
    let buf;
    let base;
    if (this._inBuf.length > 0) {
      buf = new Float32Array(this._inBuf.length + mono.length);
      buf.set(this._inBuf, 0);
      buf.set(mono, this._inBuf.length);
      base = this._inBufBase;
    } else {
      buf = mono;
      base = this._inBufBase;
    }
    const bufStart = base;
    const bufEnd = base + buf.length - 1;
    if (this._readPos < bufStart) this._readPos = bufStart;
    while (this._readPos < bufEnd) {
      const idx = Math.floor(this._readPos);
      const frac = this._readPos - idx;
      const local = idx - bufStart;
      const a = buf[local];
      const b = buf[local + 1];
      this._pushResampled(a + (b - a) * frac);
      this._readPos += this._ratio;
    }
    const keepFrom = buf.length - 1;
    this._inBuf = buf.subarray(keepFrom);
    this._inBufBase = base + keepFrom;
    return true;
  }
}

registerProcessor("steward-pcm-worklet", StewardPcmProcessor);
`;

let exposed = false;

/**
 * Start the combined-mix tap on `page` and route its 20 ms frames into
 * `forwarder.feedPcm`. Best-effort: logs and returns on any failure, never
 * throws into the caller (which is Vexa's startup path).
 *
 * Works for Google Meet and Teams: both surface the meeting audio as one or
 * more <audio>/<video> elements bound to a MediaStream. We connect every such
 * element into a single GainNode "mix" and feed the worklet from that. New
 * elements (late joiners) are reconnected on a 15 s interval, mirroring Vexa's
 * per-speaker re-scan cadence (index.ts).
 */
export async function startStewardMeetTap(
  page: Page,
  forwarder: StewardForwarder,
): Promise<void> {
  if (page.isClosed()) return;

  // Bridge worklet frames (number[] — Playwright serializes ArrayBuffer) to Node.
  if (!exposed) {
    try {
      await page.exposeFunction("__vexaStewardFrame", (frame: number[]) => {
        try {
          forwarder.feedPcm(Buffer.from(Uint8Array.from(frame)));
        } catch {
          /* best-effort tap, never break recording */
        }
      });
      exposed = true;
    } catch (err: any) {
      if (!String(err?.message).includes("has been already registered")) {
        log(`[StewardTap] Failed to expose __vexaStewardFrame: ${err?.message || err}`);
        return;
      }
      exposed = true;
    }
  }

  try {
    const connected = await page.evaluate(async (workletSource: string) => {
      const findEls = (): HTMLMediaElement[] =>
        Array.from(document.querySelectorAll("audio, video")).filter(
          (el: any) =>
            !el.paused &&
            el.srcObject instanceof MediaStream &&
            el.srcObject.getAudioTracks().length > 0,
        ) as HTMLMediaElement[];

      const els = findEls();
      if (els.length === 0) return 0;

      const blob = new Blob([workletSource], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);

      const ctx = new AudioContext(); // native rate (usually 48k)
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new (window as any).AudioWorkletNode(ctx, "steward-pcm-worklet");
      const mix = ctx.createGain(); // combined bus

      const connectedStreamIds = new Set<string>();
      const connectEl = (el: HTMLMediaElement): boolean => {
        try {
          const stream: MediaStream = (el as any).srcObject;
          if (!stream || stream.getAudioTracks().length === 0) return false;
          if (connectedStreamIds.has(stream.id)) return false;
          ctx.createMediaStreamSource(stream).connect(mix);
          connectedStreamIds.add(stream.id);
          return true;
        } catch {
          return false; // element may be re-bound elsewhere; skip
        }
      };

      let count = 0;
      for (const el of els) if (connectEl(el)) count++;

      mix.connect(node);
      // Do NOT play back into the meeting. A muted sink keeps the graph pulling.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);

      node.port.onmessage = (e: MessageEvent) => {
        // e.data is a 640-byte ArrayBuffer (s16le, 16 kHz, mono, 20 ms).
        (window as any).__vexaStewardFrame(Array.from(new Uint8Array(e.data)));
      };

      // Late-joiner re-scan: connect newly-found media elements into the same mix.
      const rescan = setInterval(() => {
        for (const el of findEls()) connectEl(el);
      }, 15000);

      (window as any).__vexaStewardCtx = ctx;
      (window as any).__vexaStewardRescan = rescan;
      return count;
    }, STEWARD_WORKLET_SOURCE);

    log(`[StewardTap] Combined-mix tap started (${connected} media element(s) connected)`);
  } catch (err: any) {
    log(`[StewardTap] Failed to start combined-mix tap: ${err?.message || err}`);
  }
}

/** Tear down the combined-mix tap (called on bot leave). Best-effort. */
export async function stopStewardMeetTap(page: Page | null): Promise<void> {
  if (!page || page.isClosed()) return;
  try {
    await page.evaluate(() => {
      try {
        const rescan = (window as any).__vexaStewardRescan;
        if (rescan) clearInterval(rescan);
        (window as any).__vexaStewardCtx?.close();
        (window as any).__vexaStewardCtx = undefined;
        (window as any).__vexaStewardRescan = undefined;
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* best-effort teardown */
  }
}
