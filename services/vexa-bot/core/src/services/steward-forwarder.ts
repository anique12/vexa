/**
 * steward-forwarder.ts — Vexa ⇄ StewardAI full-duplex audio forwarder.
 *
 * INBOUND (Vexa → StewardAI): receives meeting PCM from either capture path:
 *   - Meet/Teams: 640-byte s16le 20 ms frames posted by the AudioWorklet
 *     (steward-pcm-worklet) and bridged to Node via
 *     page.exposeFunction('__vexaStewardFrame', ...).
 *   - Zoom Web: raw s16le @ 16 kHz mono Buffers tapped from parecord stdout,
 *     in arbitrary chunk sizes.
 *   Everything is normalized to s16le / 16 kHz / mono / 20 ms (640-byte) frames
 *   and sent length-prefixed over the socket to the StewardAI bridge.
 *
 * OUTBOUND (StewardAI → Vexa): the agent sends its TTS audio BACK over the SAME
 *   socket, same framing, 16 kHz s16le. This class READS those frames off the
 *   socket, decodes them, and emits each decoded PCM payload as an "agentPcm"
 *   event (a Node Buffer). index.ts feeds those buffers to TTSPlaybackService so
 *   they play into the meeting via PulseAudio tts_sink.
 *
 * Wire format (BOTH directions) — type-tagged; MUST byte-match the StewardAI
 * agent's bridge transport:
 *
 *     frame = [4-byte big-endian uint32 L][1 byte TYPE][DATA]
 *
 * where L = 1 + DATA.length (the length counts the type byte + the data).
 * Types: 0x00 = s16le PCM audio, 0x01 = handshake JSON. On every (re)connect the
 * forwarder sends a TYPE_HANDSHAKE frame FIRST — UTF-8 JSON
 * { meeting_id, native_meeting_id, v: 1 } — so the agent binds the connection to
 * the meeting, then streams TYPE_PCM frames. Outbound PCM DATA is always 640
 * bytes. Inbound frames (from the agent) may use ANY L — we tolerate partial
 * reads and any frame size (n == 0 skipped, n > 1 MiB treated as a desync and
 * the read buffer reset); TYPE_PCM DATA is emitted as "agentPcm", other types
 * are logged and ignored.
 *
 * Self-contained: uses only Node's `net` and `events` (no new npm deps; `net`
 * is already imported in vexa-bot index.ts). Connect/reconnect is handled
 * internally with backoff; if the StewardAI agent isn't listening yet, frames
 * are dropped (bounded) until the socket comes up. The forwarder is strictly
 * best-effort: it must never throw into Vexa's recording/playback path.
 *
 * Drop-in location: services/vexa-bot/core/src/services/steward-forwarder.ts
 */

import * as net from "net";
import { EventEmitter } from "events";

const FRAME_BYTES = 640; // 20 ms @ 16 kHz mono s16le (320 samples × 2)
const HEADER_BYTES = 4; // big-endian uint32 length prefix
const MAX_FRAME = 1 << 20; // 1 MiB — matches transport.py's desync guard

// --- Type-tagged bridge protocol (MUST byte-match the StewardAI agent) ---
// Every frame on the socket is: [4-byte BE uint32 L][1 byte TYPE][DATA],
// where L = 1 + DATA.length (the length counts the type byte + the data).
const TYPE_PCM = 0x00; // s16le PCM audio (combined mix)
const TYPE_HANDSHAKE = 0x01; // handshake JSON
const TYPE_PCM_SPEAKER = 0x02; // [nameLen:u8][name utf8][s16le pcm] — one speaker's segment
// Keep a single per-speaker frame under the agent's 1 MiB (_MAX_FRAME) cap; a
// longer utterance is split across frames (agent transcribes each independently).
const MAX_SPEAKER_PCM = 900_000;

export type StewardTransport = "tcp" | "unix";

export interface StewardForwarderOptions {
  /**
   * Vexa meeting id (INTEGER). Sent in the handshake so the agent binds this
   * connection to the correct meeting. Threaded from botConfig.meeting_id.
   */
  meetingId?: number;
  /**
   * Native meeting id (the platform meeting-code string). Sent in the
   * handshake alongside meetingId. Threaded from botConfig.nativeMeetingId.
   */
  nativeMeetingId?: string;
  /** "tcp" | "unix". Default from BRIDGE_TRANSPORT, else "tcp". */
  transport?: StewardTransport;
  /** TCP host. Default from BRIDGE_TCP_HOST, else "127.0.0.1". */
  tcpHost?: string;
  /** TCP port. Default from BRIDGE_TCP_PORT, else 8765. */
  tcpPort?: number;
  /** Unix socket path. Default from BRIDGE_SOCKET_PATH, else "/tmp/stewardai.sock". */
  socketPath?: string;
  /**
   * Input sample format hint (INBOUND meeting audio fed via feedPcm):
   *   - "s16le" (default): feedPcm receives 16-bit PCM Buffers (Zoom parecord,
   *     and the worklet path which already emits s16le bytes).
   *   - "f32": feedPcm receives 32-bit float little-endian Buffers in [-1, 1]
   *     (only if you choose to forward raw Float32 instead of the worklet's
   *     s16le output). Converted to s16le here.
   */
  inputFormat?: "s16le" | "f32";
  /**
   * Max bytes to buffer while disconnected before dropping oldest. Bounds
   * memory if the agent is down for a long time. Default ~2s of audio.
   */
  maxPendingBytes?: number;
  /** Optional logger; defaults to console.error-style no-op-safe logging. */
  log?: (msg: string) => void;
}

/** Resolve options from explicit values then env then defaults. */
function resolveOptions(opts: StewardForwarderOptions): Required<
  Omit<StewardForwarderOptions, "log">
> & { log: (msg: string) => void } {
  const env = process.env;
  const transport =
    (opts.transport || (env.BRIDGE_TRANSPORT as StewardTransport) || "tcp") === "unix"
      ? "unix"
      : "tcp";
  return {
    meetingId: opts.meetingId ?? 0,
    nativeMeetingId: opts.nativeMeetingId || "",
    transport,
    tcpHost: opts.tcpHost || env.BRIDGE_TCP_HOST || "127.0.0.1",
    tcpPort: opts.tcpPort ?? (env.BRIDGE_TCP_PORT ? parseInt(env.BRIDGE_TCP_PORT, 10) : 8765),
    socketPath: opts.socketPath || env.BRIDGE_SOCKET_PATH || "/tmp/stewardai.sock",
    inputFormat: opts.inputFormat || "s16le",
    maxPendingBytes: opts.maxPendingBytes ?? FRAME_BYTES * 50 * 2, // ~2s
    log: opts.log || ((m: string) => console.log(`[steward-forwarder] ${m}`)),
  };
}

/**
 * Events emitted:
 *   - "agentPcm" (Buffer):    one decoded outbound (agent→Vexa) PCM frame.
 *   - "connected" ():         socket connected to the StewardAI bridge.
 *   - "disconnected" ():      socket closed (auto-reconnect scheduled).
 *   - "backpressure" ():      a write returned false (non-fatal).
 *   - "closed" ():            close() finished.
 */
export class StewardForwarder extends EventEmitter {
  private o: ReturnType<typeof resolveOptions>;
  private socket: net.Socket | null = null;
  private connected = false;
  private closed = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 250;
  private readonly backoffMaxMs = 5000;

  /** Carries a partial (<640B) tail of s16le PCM between feedPcm() calls. */
  private resliceTail: Buffer = Buffer.alloc(0);
  /** Frames buffered while disconnected (each already length-prefixed). */
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  /**
   * INBOUND READ buffer: accumulates bytes received from the agent until a full
   * [4-byte length][payload] frame is available. Carried across "data" events.
   */
  private recvBuf: Buffer = Buffer.alloc(0);

  // Lightweight stats (emitted on close / queryable for logging).
  public framesSent = 0;
  public framesDropped = 0;
  public framesReceived = 0;

  constructor(opts: StewardForwarderOptions = {}) {
    super();
    this.o = resolveOptions(opts);
  }

  /** Begin connecting. Safe to call once; reconnects are automatic. */
  start(): void {
    if (this.closed) return;
    this._connect();
  }

  /**
   * Feed INBOUND meeting PCM from a capture source. Accepts a Node Buffer (or
   * anything Buffer.from can wrap). Reslices to exact 640-byte s16le frames; the
   * remainder is carried to the next call. Never throws — capture paths can call
   * this without try/catch and still be safe, but wrapping is cheap.
   */
  feedPcm(chunk: Buffer | Uint8Array | ArrayBuffer): void {
    if (this.closed) return;
    try {
      let buf: Buffer;
      if (Buffer.isBuffer(chunk)) {
        buf = chunk;
      } else if (chunk instanceof Uint8Array) {
        // Wrap the same memory (view), then copy on reslice as needed.
        buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      } else {
        buf = Buffer.from(chunk as ArrayBuffer);
      }

      if (this.o.inputFormat === "f32") {
        buf = this._f32ToS16le(buf);
      }

      // Reslice into exact 20 ms (640-byte) frames.
      const data = this.resliceTail.length
        ? Buffer.concat([this.resliceTail, buf])
        : buf;

      let off = 0;
      while (data.length - off >= FRAME_BYTES) {
        // subarray is a view; copy so the queued/written buffer is stable.
        const frame = Buffer.from(data.subarray(off, off + FRAME_BYTES));
        this._sendFrame(frame);
        off += FRAME_BYTES;
      }
      this.resliceTail = off < data.length ? Buffer.from(data.subarray(off)) : Buffer.alloc(0);
    } catch (err: any) {
      this.o.log(`feedPcm error (dropped): ${err?.message || err}`);
    }
  }

  /**
   * Send the handshake frame ([BE32(1+hs.length)][0x01][hs]) as the very first
   * bytes on the (re)connected socket. hs is UTF-8 JSON:
   *   { meeting_id: <int>, native_meeting_id: <str>, v: 1 }
   * Best-effort: writes directly (does not queue) since onConnect guarantees the
   * socket is connected+writable at this point.
   */
  private _sendHandshake(): void {
    if (!this.socket || !this.socket.writable) return;
    const hs = Buffer.from(
      JSON.stringify({
        meeting_id: this.o.meetingId,
        native_meeting_id: this.o.nativeMeetingId,
        v: 1,
      }),
      "utf8",
    );
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32BE(1 + hs.length, 0); // L counts the type byte + the JSON
    const packet = Buffer.concat(
      [header, Buffer.from([TYPE_HANDSHAKE]), hs],
      HEADER_BYTES + 1 + hs.length,
    );
    this.socket.write(packet);
    this.o.log(
      `handshake sent (meeting_id=${this.o.meetingId}, native_meeting_id=${this.o.nativeMeetingId})`,
    );
  }

  /** Type-tag one 640-byte PCM frame ([BE32(1+len)][0x00][frame]) and write (or queue) it. */
  private _sendFrame(frame: Buffer): void {
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    // L counts the type byte + the data (matches the agent's transport).
    header.writeUInt32BE(1 + frame.length, 0);
    const packet = Buffer.concat(
      [header, Buffer.from([TYPE_PCM]), frame],
      HEADER_BYTES + 1 + frame.length,
    );

    if (this.connected && this.socket && this.socket.writable) {
      // writable false / write returning false (backpressure) → still buffered
      // by Node's socket; we let the kernel/Node handle backpressure here.
      const ok = this.socket.write(packet);
      this.framesSent += 1;
      if (!ok) {
        // Backpressure signal — not fatal; Node will drain. Just note it.
        this.emit("backpressure");
      }
    } else {
      this._queue(packet);
    }
  }

  /**
   * Forward one speaker's utterance segment (s16le PCM @ 16 kHz) tagged with the
   * speaker's display name. Frame: [BE32(1+1+nameLen+pcmLen)][0x02][nameLen:u8]
   * [name][pcm]. Chunks pcm to stay under the agent's 1 MiB frame cap. Best-effort:
   * a bad segment is dropped, never thrown.
   */
  feedSpeakerPcm(speaker: string, audio: Float32Array): void {
    try {
      if (!audio || audio.length === 0) return;
      // Float32 @ 16 kHz (from Vexa's speakerManager) -> s16le, matching the agent.
      const pcm = this._f32ToS16le(
        Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength),
      );
      if (pcm.length === 0) return;
      let name = Buffer.from(String(speaker ?? ""), "utf8");
      if (name.length > 255) name = name.subarray(0, 255);
      for (let i = 0; i < pcm.length; i += MAX_SPEAKER_PCM) {
        this._sendSpeakerFrame(name, pcm.subarray(i, i + MAX_SPEAKER_PCM));
      }
    } catch (err: any) {
      this.o.log(`feedSpeakerPcm error (dropped): ${err?.message || err}`);
    }
  }

  /** Type-tag one per-speaker segment ([BE32][0x02][nameLen][name][pcm]) and write (or queue) it. */
  private _sendSpeakerFrame(name: Buffer, pcm: Buffer): void {
    const bodyLen = 1 + name.length + pcm.length; // nameLen byte + name + pcm
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32BE(1 + bodyLen, 0); // + the type byte
    const packet = Buffer.concat(
      [header, Buffer.from([TYPE_PCM_SPEAKER]), Buffer.from([name.length]), name, pcm],
      HEADER_BYTES + 1 + bodyLen,
    );
    if (this.connected && this.socket && this.socket.writable) {
      const ok = this.socket.write(packet);
      this.framesSent += 1;
      if (!ok) this.emit("backpressure");
    } else {
      this._queue(packet);
    }
  }

  private _queue(packet: Buffer): void {
    this.pending.push(packet);
    this.pendingBytes += packet.length;
    // Bound memory: drop oldest frames if the agent is down too long.
    while (this.pendingBytes > this.o.maxPendingBytes && this.pending.length > 0) {
      const dropped = this.pending.shift()!;
      this.pendingBytes -= dropped.length;
      this.framesDropped += 1;
    }
  }

  private _flushPending(): void {
    if (!this.socket || !this.socket.writable) return;
    while (this.pending.length > 0) {
      const packet = this.pending.shift()!;
      this.pendingBytes -= packet.length;
      this.socket.write(packet);
      this.framesSent += 1;
    }
  }

  /**
   * INBOUND frame decoder. Appends `chunk` to recvBuf and pulls out every
   * complete [4-byte BE length][1-byte TYPE][DATA] frame, where the length N
   * counts the type byte + the data. For TYPE_PCM frames the DATA (payload minus
   * the type byte) is emitted as "agentPcm"; any other type is logged and
   * ignored. Tolerates partial reads (the tail is carried in recvBuf) and is
   * resilient to a desynced/garbage length prefix (resets the buffer rather
   * than allocating wildly). Strictly best-effort: never throws upward.
   */
  private _onData(chunk: Buffer): void {
    try {
      this.recvBuf = this.recvBuf.length
        ? Buffer.concat([this.recvBuf, chunk])
        : chunk;

      let off = 0;
      while (this.recvBuf.length - off >= HEADER_BYTES) {
        const n = this.recvBuf.readUInt32BE(off);
        if (n === 0) {
          // Zero-length frame — skip the header (matches the agent's transport).
          off += HEADER_BYTES;
          continue;
        }
        if (n > MAX_FRAME) {
          // Desynced/garbage length. Drop everything buffered and resync from
          // the next bytes that arrive rather than allocating up to ~4 GiB.
          this.o.log(`recv frame_too_large (n=${n}) — resetting read buffer`);
          this.recvBuf = Buffer.alloc(0);
          return;
        }
        if (this.recvBuf.length - off < HEADER_BYTES + n) {
          // Full payload not here yet — wait for more bytes.
          break;
        }
        const start = off + HEADER_BYTES;
        // The n-byte payload is [1-byte TYPE][DATA]. Copy out so the emitted
        // Buffer is stable independent of recvBuf reuse.
        const payload = Buffer.from(this.recvBuf.subarray(start, start + n));
        off = start + n;
        const type = payload[0];
        if (type === TYPE_PCM) {
          this.framesReceived += 1;
          this.emit("agentPcm", payload.subarray(1));
        } else {
          // Unknown/stray frame type — log and ignore, never crash.
          this.o.log(`recv unknown frame type=0x${type.toString(16)} (len=${n}) — ignored`);
        }
      }

      // Carry the unconsumed tail (partial header or partial payload).
      this.recvBuf = off > 0
        ? (off < this.recvBuf.length ? Buffer.from(this.recvBuf.subarray(off)) : Buffer.alloc(0))
        : this.recvBuf;
    } catch (err: any) {
      this.o.log(`recv decode error (dropped): ${err?.message || err}`);
      // On any unexpected error, drop the buffer to avoid a stuck desync.
      this.recvBuf = Buffer.alloc(0);
    }
  }

  private _connect(): void {
    if (this.closed || this.connecting || this.connected) return;
    this.connecting = true;

    const onConnect = () => {
      this.connecting = false;
      this.connected = true;
      this.backoffMs = 250; // reset backoff on a good connection
      this.recvBuf = Buffer.alloc(0); // fresh read state per connection
      this.o.log(
        this.o.transport === "unix"
          ? `connected (unix ${this.o.socketPath})`
          : `connected (tcp ${this.o.tcpHost}:${this.o.tcpPort})`,
      );
      // Handshake MUST be the very first bytes on every (re)connect, before any
      // PCM, so the agent binds this connection to the correct meeting.
      this._sendHandshake();
      this.emit("connected");
      this._flushPending();
    };

    const sock =
      this.o.transport === "unix"
        ? net.createConnection({ path: this.o.socketPath }, onConnect)
        : net.createConnection({ host: this.o.tcpHost, port: this.o.tcpPort }, onConnect);

    sock.setNoDelay(true); // low-latency: don't Nagle-coalesce 640-byte frames

    // INBOUND: decode agent TTS frames off the same socket.
    sock.on("data", (buf: Buffer) => this._onData(buf));

    sock.on("error", (err: any) => {
      // ECONNREFUSED etc. while the agent isn't up yet — expected; reconnect.
      this.o.log(`socket error: ${err?.code || err?.message || err}`);
    });

    sock.on("close", () => {
      this.connected = false;
      this.connecting = false;
      this.socket = null;
      this.recvBuf = Buffer.alloc(0); // discard a half-frame from the dead socket
      this.emit("disconnected");
      this._scheduleReconnect();
    });

    this.socket = sock;
  }

  private _scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  /** Convert little-endian float32 [-1,1] PCM to s16le. */
  private _f32ToS16le(buf: Buffer): Buffer {
    const n = Math.floor(buf.length / 4);
    const out = Buffer.allocUnsafe(n * 2);
    for (let i = 0; i < n; i++) {
      let s = buf.readFloatLE(i * 4);
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      out.writeInt16LE(v, i * 2);
    }
    return out;
  }

  /** True if the bridge socket is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Stop forwarding and close the socket. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.connected = false;
    this.recvBuf = Buffer.alloc(0);
    this.o.log(
      `closed (sent=${this.framesSent}, dropped=${this.framesDropped}, received=${this.framesReceived})`,
    );
    this.emit("closed");
  }
}

/**
 * Convenience factory used by index.ts:
 *
 *   import { createStewardForwarder } from "./services/steward-forwarder";
 *   const stewardForwarder = createStewardForwarder();   // reads BRIDGE_* env
 *   stewardForwarder.start();
 *   stewardForwarder.on("agentPcm", (frame) => { ...play to tts_sink... });
 *   // Zoom:        pulseAudioCapture.setStewardForwarder(stewardForwarder)
 *   // Meet/Teams:  expose '__vexaStewardFrame' → stewardForwarder.feedPcm(...)
 *   // on leave:    stewardForwarder.close()
 */
export function createStewardForwarder(
  opts: StewardForwarderOptions = {},
): StewardForwarder {
  const fwd = new StewardForwarder(opts);
  return fwd;
}
