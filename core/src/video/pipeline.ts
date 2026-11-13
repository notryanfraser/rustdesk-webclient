// VideoPipeline: WebCodecs decode + canvas render. Browser-only at runtime
// (VideoDecoder, EncodedVideoChunk, canvas); nothing is touched at import time. Runs inside the
// video worker (worker.ts) on an OffscreenCanvas, or on the main thread on any canvas.
//
// Decoding rules (all observed):
// * A decoder accepts only a keyframe after configure() or an error. On a codec change we
// reconfigure at the new codec's keyframe; a stray delta of the previous codec (the peer
// sends one after a switch) is dropped without fuss. A delta while we wait for a keyframe of
// the current codec rejects submit(), which makes VideoStream send refresh_video.
// * Size comes from the decoded frame's displayWidth/displayHeight, never codedWidth
// (Chromium's VP9 output is coded 2784 wide for a 2700-wide display). A resolution change on
// the remote arrives as a keyframe at the new size: the canvas follows the frames.
// * Output pixel formats differ by browser (I420, BGRX), so frames are drawn with drawImage.
// * Hardware decoding is asked for ("prefer-hardware") where the probe (probe.ts) found the
// browser offers it. If such a decoder then fails, that codec is configured without the hint
// from then on, so a broken hardware decoder costs one keyframe, not the session.
//
// Rendering: only the newest decoded frame is drawn, on the next animation frame; a frame
// superseded before then is closed undrawn (droppedStale). submit() resolves when the decoder
// has output its chunks (not when drawn), or after ackTimeoutMs at the latest, so the peer is
// never held up by a decoder that swallowed a chunk.

import type {
  DecoderChoices,
  VideoChunk,
  VideoCodec,
  VideoSink,
  VideoStats,
} from "./types.js";
import { CODEC_STRINGS, EMPTY_STATS } from "./types.js";

export interface VideoPipelineOptions {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  onStats?: (s: VideoStats) => void;
  /** The drawn size changed (first frame, remote resolution change, display switch). */
  onResize?: (width: number, height: number) => void;
  /** Default 1000. */
  statsIntervalMs?: number;
  /** Default 250. */
  ackTimeoutMs?: number;
  /** From probeDecoders(). Without it: the default codec strings, no hardware hint. */
  decoders?: DecoderChoices;
}

interface PendingMessage {
  remaining: number;
  settled: boolean;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Draw2D {
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
}

export class VideoPipeline implements VideoSink {
  private decoder: VideoDecoder | undefined;
  private codec: VideoCodec | undefined;
  private needKey = true;
  /** The current decoder was configured with "prefer-hardware". */
  private hardware = false;
  /** Codecs whose hardware decoder failed. */
  private readonly noHardware = new Set<VideoCodec>();
  /** One entry per chunk handed to the decoder, in decode order. */
  private fifo: { msg: PendingMessage; t0: number }[] = [];
  private latest: VideoFrame | undefined;
  private drawScheduled = false;
  private closed = false;
  private readonly ctx: Draw2D;
  private readonly statsTimer: ReturnType<typeof setInterval> | undefined;
  private readonly totals = { ...EMPTY_STATS };
  private intervalFrames = 0;
  private intervalDecodeMs = 0;
  private intervalDecoded = 0;
  private intervalStart = performance.now();
  private readonly ackTimeoutMs: number;
  private probe: OffscreenCanvas | undefined;

  constructor(private readonly opts: VideoPipelineOptions) {
    const ctx = opts.canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    }) as unknown as Draw2D | null;
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 250;
    if (opts.onStats)
      this.statsTimer = setInterval(
        () => this.reportStats(),
        opts.statsIntervalMs ?? 1000,
      );
  }

  get stats(): VideoStats {
    return { ...this.totals };
  }

  submit(chunks: VideoChunk[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const msg: PendingMessage = {
        remaining: 0,
        settled: false,
        resolve: () => {
          if (msg.settled) return;
          msg.settled = true;
          clearTimeout(msg.timer);
          resolve();
        },
        reject: (e) => {
          if (msg.settled) return;
          msg.settled = true;
          clearTimeout(msg.timer);
          reject(e);
        },
        timer: setTimeout(() => {
          if (msg.settled) return;
          this.totals.ackTimeouts++;
          msg.resolve();
        }, this.ackTimeoutMs),
      };
      if (this.closed) return msg.resolve();
      let wantKey = false;
      for (const c of chunks) {
        const r = this.decodeOne(c, msg);
        if (r === "need-key") wantKey = true;
      }
      if (msg.remaining === 0) {
        if (wantKey) msg.reject(new Error("waiting for a keyframe"));
        else msg.resolve();
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.statsTimer);
    this.resetDecoder();
    this.latest?.close();
    this.latest = undefined;
  }

  private decodeOne(
    c: VideoChunk,
    msg: PendingMessage,
  ): "queued" | "dropped" | "need-key" {
    if (c.codec !== this.codec || !this.decoder) {
      if (!c.key) {
        this.totals.droppedAwaitingKey++;
        // A delta of the previous codec right after a switch is expected (one in flight);
        // with no decoder at all we genuinely need a keyframe.
        return this.decoder ? "dropped" : "need-key";
      }
      this.configure(c.codec);
    } else if (this.needKey && !c.key) {
      this.totals.droppedAwaitingKey++;
      return "need-key";
    }
    const decoder = this.decoder!;
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: c.key ? "key" : "delta",
          timestamp: c.timestampUs,
          data: c.data,
        }),
      );
    } catch (e) {
      this.fail(e);
      msg.reject(e instanceof Error ? e : new Error(String(e)));
      return "need-key";
    }
    this.needKey = false;
    msg.remaining++;
    this.fifo.push({ msg, t0: performance.now() });
    return "queued";
  }

  private configure(codec: VideoCodec): void {
    this.resetDecoder();
    const decoder = new VideoDecoder({
      output: (f) => this.onOutput(decoder, f),
      error: (e) => {
        if (this.decoder === decoder) this.fail(e);
      },
    });
    const choice = this.opts.decoders?.[codec];
    const hardware = !!choice?.hardware && !this.noHardware.has(codec);
    decoder.configure({
      codec: choice?.codec ?? CODEC_STRINGS[codec],
      optimizeForLatency: true,
      ...(hardware ? { hardwareAcceleration: "prefer-hardware" } : {}),
    });
    this.decoder = decoder;
    this.codec = codec;
    this.hardware = hardware;
    this.needKey = true;
    this.totals.codec = codec;
    this.totals.decoder = hardware
      ? "hardware"
      : choice && !choice.hardware
        ? "software"
        : "";
  }

  /** Close the current decoder; messages waiting on it are released (acked). */
  private resetDecoder(): void {
    const d = this.decoder;
    this.decoder = undefined;
    this.codec = undefined;
    this.needKey = true;
    if (d && d.state !== "closed") d.close();
    for (const p of this.fifo.splice(0)) p.msg.resolve();
  }

  private fail(e: unknown): void {
    this.totals.decodeErrors++;
    if (this.hardware && this.codec) this.noHardware.add(this.codec);
    const pending = this.fifo.splice(0);
    this.resetDecoder();
    const err = e instanceof Error ? e : new Error(String(e));
    for (const p of pending) p.msg.reject(err);
  }

  private onOutput(from: VideoDecoder, frame: VideoFrame): void {
    if (this.closed || from !== this.decoder) {
      frame.close();
      return;
    }
    const p = this.fifo.shift();
    if (p) {
      this.intervalDecodeMs += performance.now() - p.t0;
      this.intervalDecoded++;
      if (--p.msg.remaining <= 0) p.msg.resolve();
    }
    this.totals.decoded++;
    if (this.latest) {
      this.latest.close();
      this.totals.droppedStale++;
    }
    this.latest = frame;
    if (!this.drawScheduled) {
      this.drawScheduled = true;
      const raf = (
        globalThis as { requestAnimationFrame?: (cb: () => void) => number }
      ).requestAnimationFrame;
      if (raf) raf(() => this.draw());
      else setTimeout(() => this.draw(), 0);
    }
  }

  private draw(): void {
    this.drawScheduled = false;
    const f = this.latest;
    this.latest = undefined;
    if (!f || this.closed) {
      f?.close();
      return;
    }
    const w = f.displayWidth;
    const h = f.displayHeight;
    const canvas = this.opts.canvas;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      this.totals.width = w;
      this.totals.height = h;
      this.opts.onResize?.(w, h);
    }
    this.ctx.drawImage(f, 0, 0);
    f.close();
    this.totals.rendered++;
    this.intervalFrames++;
  }

  private meanLuma(): number {
    if (typeof OffscreenCanvas === "undefined") return -1;
    this.probe ??= new OffscreenCanvas(16, 9);
    const p = this.probe.getContext("2d", { willReadFrequently: true });
    if (!p) return -1;
    p.drawImage(this.opts.canvas, 0, 0, 16, 9);
    const d = p.getImageData(0, 0, 16, 9).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4)
      sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    return sum / (d.length / 4);
  }

  private reportStats(): void {
    const now = performance.now();
    const secs = (now - this.intervalStart) / 1000;
    const s: VideoStats = {
      ...this.totals,
      fps: secs > 0 ? this.intervalFrames / secs : 0,
      decodeMs: this.intervalDecoded
        ? this.intervalDecodeMs / this.intervalDecoded
        : 0,
      meanLuma: this.totals.rendered ? this.meanLuma() : -1,
    };
    this.intervalStart = now;
    this.intervalFrames = 0;
    this.intervalDecodeMs = 0;
    this.intervalDecoded = 0;
    this.opts.onStats?.(s);
  }
}
