// AudioPlayer: Opus packets -> WebCodecs AudioDecoder -> AudioWorklet ring buffer
// (the jitter buffer, worklet.ts) -> speakers. Implements AudioSink for AudioStream.
// Browser-only at runtime; nothing is touched at import time.
//
// * The AudioContext runs at the peer's sample rate (48 kHz), so nothing is resampled by us.
// Browsers only start audio after a user gesture on the page: create the player (it creates
// its AudioContext in the constructor) from a click, e.g. the Connect button.
// * Opus packets carry no timestamps on the wire; each is a separate 10 ms packet decoded in
// order, so chunk timestamps are just a counter.
// * Adaptive jitter buffer. Arrival is not always smooth: a 1.5.3 Linux peer on classic
// PulseAudio opens its capture with default buffer attributes (src/ipc.rs start_pa, around
// 1627-1636), so it reads, and sends, audio in bursts of about 2 s (measured: 32 packets,
// a 1.95 s pause, then 196 packets within 1 ms). The worklet's target level is therefore
// the largest inter-arrival gap of the last 10 s plus 60 ms (minimum 60 ms, maximum 2.5 s;
// gaps over 3 s are pauses, e.g. the peer's noise gate, not jitter). Clock drift between the
// peer and us is corrected by playing 0.5% fast or slow (worklet.ts), not by dropping audio;
// it only trims, as a last resort, what exceeds target + max(200 ms, target / 2). Smooth
// peers get roughly 60-150 ms; a bursty one about its burst length, which cannot be avoided
// without dropping audio (the native client keeps up to AUDIO_BUFFER_MS = 3000 ms for the
// same reason, src/client.rs 136, 2245-2305).

import type { AudioOutputFormat, AudioSink } from "./stream.js";
import { WORKLET_NAME, WORKLET_SOURCE } from "./worklet.js";

export interface AudioPlayerStats {
  decoded: number;
  decodeErrors: number;
  /** From the worklet: frames played, frames of silence output, queue rebuffers, frames dropped. */
  playedFrames: number;
  silentFrames: number;
  rebuffers: number;
  droppedFrames: number;
  /** Render quanta with a discontinuity in the output (see worklet.ts). */
  clicks: number;
  /** Largest second difference of the output in the last report (diagnostic). */
  maxStep: number;
  bufferedMs: number;
  /** Current jitter-buffer target (adaptive, see the header), ms. */
  targetMs: number;
  /** Largest packet inter-arrival gap in the last 10 s, ms. */
  arrivalGapMs: number;
  /** Current playback rate: 1, or 1 +- 0.005 while correcting clock drift (worklet.ts). */
  rate: number;
  /**
   * Packet gaps longer than the jitter-buffer target at the time (under 3 s): stalls on the peer
   * or network that no low-latency buffer rides out; each may cause one rebuffer.
   */
  stalls: number;
  /** bufferedMs + the context's reported output latency: our share of the end-to-end delay. */
  latencyMs: number;
  playing: boolean;
  muted: boolean;
  contextState: string;
  /** AudioContext.currentTime, s: compare with wall time to see whether audio renders in real time. */
  contextTime: number;
}

export interface AudioPlayerOptions {
  /** Minimum jitter-buffer target, ms (default 60). */
  minTargetMs?: number;
  /** Maximum jitter-buffer target, ms (default 2500). */
  maxTargetMs?: number;
  onStats?: (s: AudioPlayerStats) => void;
  /** Test tap: every decoded packet, planar float32, before it is queued for playback. */
  onDecoded?: (planes: Float32Array[], sampleRate: number) => void;
  /**
   * URL of a script holding WORKLET_SOURCE (same origin), e.g. "audio-worklet.js" written by the
   * app's build. Without it the worklet is loaded from a Blob URL, which needs a CSP that allows
   * blob: scripts; with it, script-src 'self' is enough.
   */
  workletUrl?: string;
}

export class AudioPlayer implements AudioSink {
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private gain: GainNode | undefined;
  private decoder: AudioDecoder | undefined;
  private format: AudioOutputFormat | undefined;
  private ready: Promise<void> | undefined;
  private pending: Float32Array[][] = [];
  private ts = 0;
  private muted = false;
  /** Packet arrival gaps of the last 10 s: [arrival time, gap] (ms). */
  private gaps: [number, number][] = [];
  private lastArrival = 0;
  private targetMs = 0;
  private maxGapMs = 0;
  private closed = false;
  private readonly counts = { decoded: 0, decodeErrors: 0, stalls: 0 };
  private last: Partial<AudioPlayerStats> = {};

  /**
   * Creates the AudioContext right away, at `sampleRate` (default 48000, what peers send): call
   * this from a user gesture (the Connect click). Firefox keeps a context created later, outside
   * a gesture, suspended (its default "block-webaudio" autoplay policy), so creating it when the
   * first audio_format arrives would leave it silent.
   */
  constructor(
    private readonly opts: AudioPlayerOptions & { sampleRate?: number } = {},
  ) {
    if (typeof AudioContext !== "undefined")
      this.newContext(opts.sampleRate ?? 48_000);
  }

  /** Resume a suspended AudioContext; call from a user gesture if playback has not started. */
  async resume(): Promise<void> {
    try {
      await this.ctx?.resume();
    } catch {
      // closed meanwhile (session ended): nothing to resume
    }
  }

  configure(format: AudioOutputFormat): void {
    if (this.closed) return;
    const prev = this.format;
    this.format = format;
    if (!this.ctx || this.ctx.sampleRate !== format.sampleRate)
      this.newContext(format.sampleRate); // a peer at another rate: a new context (rare)
    if (!this.node || prev?.channels !== format.channels)
      this.startNode(format);
    this.startDecoder(format);
  }

  push(packet: Uint8Array): void {
    if (this.closed || !this.format) return;
    this.noteArrival(performance.now());
    if (!this.decoder || this.decoder.state === "closed")
      this.startDecoder(this.format);
    try {
      this.decoder!.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: this.ts,
          data: packet,
        }),
      );
      this.ts += 10_000;
    } catch {
      this.counts.decodeErrors++;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain && this.ctx)
      this.gain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01);
    if (muted) this.node?.port.postMessage({ type: "flush" });
  }

  get stats(): AudioPlayerStats {
    return this.snapshot();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    void this.ctx?.close().catch(() => {});
  }

  /** A context and its worklet module; the node is created once the format is known. */
  private newContext(sampleRate: number): void {
    void this.ctx?.close().catch(() => {});
    const ctx = new AudioContext({ sampleRate, latencyHint: "interactive" });
    this.ctx = ctx;
    this.node = undefined;
    if (this.opts.workletUrl) {
      this.ready = ctx.audioWorklet.addModule(this.opts.workletUrl);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "text/javascript" }),
    );
    this.ready = ctx.audioWorklet
      .addModule(url)
      .finally(() => URL.revokeObjectURL(url));
  }

  private startNode(format: AudioOutputFormat): void {
    const ctx = this.ctx!;
    const sr = format.sampleRate;
    this.node?.disconnect();
    this.node = undefined;
    void this.ready!.then(() => {
      if (this.ctx !== ctx || this.closed) return;
      const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
        numberOfInputs: 0,
        outputChannelCount: [format.channels],
        processorOptions: {
          channels: format.channels,
          capacityFrames: 6 * sr,
          ...this.levels(sr),
        },
      });
      node.port.onmessage = (e) => {
        if (e.data?.type !== "stats") return;
        this.last = e.data;
        this.opts.onStats?.(this.snapshot());
      };
      const gain = ctx.createGain();
      gain.gain.value = this.muted ? 0 : 1;
      node.connect(gain).connect(ctx.destination);
      this.node = node;
      this.gain = gain;
      for (const planes of this.pending.splice(0)) this.send(planes);
      node.port.postMessage({ type: "target", ...this.levels(sr) });
    });
  }

  private startDecoder(format: AudioOutputFormat): void {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    const decoder = new AudioDecoder({
      output: (data) => this.onDecoded(data),
      error: () => {
        this.counts.decodeErrors++;
      },
    });
    decoder.configure({
      codec: "opus",
      sampleRate: format.sampleRate,
      numberOfChannels: format.channels,
    });
    this.decoder = decoder;
  }

  private onDecoded(data: AudioData): void {
    const frames = data.numberOfFrames;
    const planes: Float32Array[] = [];
    for (let c = 0; c < data.numberOfChannels; c++) {
      const p = new Float32Array(frames);
      data.copyTo(p, { planeIndex: c, format: "f32-planar" });
      planes.push(p);
    }
    const sr = data.sampleRate;
    data.close();
    this.counts.decoded++;
    this.opts.onDecoded?.(planes, sr);
    if (this.muted) return;
    if (this.node) this.send(planes);
    else if (this.pending.length < 50) this.pending.push(planes);
  }

  private send(planes: Float32Array[]): void {
    this.node?.port.postMessage(
      { type: "push", planes },
      planes.map((p) => p.buffer as ArrayBuffer),
    );
  }

  /** Track arrival gaps; retarget the worklet when the needed buffering changes. */
  private noteArrival(now: number): void {
    if (this.lastArrival) {
      const gap = now - this.lastArrival;
      if (gap < 3000) {
        this.gaps.push([now, gap]);
        if (this.targetMs && gap > this.targetMs) this.counts.stalls++;
      }
    }
    this.lastArrival = now;
    while (this.gaps.length && this.gaps[0]![0] < now - 10_000)
      this.gaps.shift();
    let maxGap = 0;
    for (const [, g] of this.gaps) if (g > maxGap) maxGap = g;
    this.maxGapMs = maxGap;
    const min = this.opts.minTargetMs ?? 60;
    const target = Math.min(
      Math.max(maxGap + 60, min),
      this.opts.maxTargetMs ?? 2500,
    );
    // Retarget on a 10% (and at least 10 ms) change, so steady jitter does not chatter.
    if (Math.abs(target - this.targetMs) > Math.max(10, this.targetMs * 0.1)) {
      this.targetMs = target;
      this.node?.port.postMessage({
        type: "target",
        ...this.levels(this.format!.sampleRate),
      });
    }
  }

  private levels(sr: number): {
    targetFrames: number;
    maxFrames: number;
    gapFrames: number;
  } {
    const target = this.targetMs || (this.opts.minTargetMs ?? 60);
    return {
      targetFrames: Math.round((target * sr) / 1000),
      // Trim above target + max(200 ms, target / 2): with ~2 s bursts the level swings between
      // ~0 and the target, and a late burst (2.12 s seen) still fits without a trim.
      maxFrames: Math.round(((target + Math.max(200, target / 2)) * sr) / 1000),
      // Sizes the worklet's drift-control window (lowest level over >= 1.5 x this gap).
      gapFrames: Math.round((this.maxGapMs * sr) / 1000),
    };
  }

  private snapshot(): AudioPlayerStats {
    const sr = this.format?.sampleRate ?? 48_000;
    const l = this.last as Record<string, number | boolean>;
    const bufferedMs = (((l.bufferedFrames as number) ?? 0) * 1000) / sr;
    const out = this.ctx
      ? (this.ctx.outputLatency || this.ctx.baseLatency || 0) * 1000
      : 0;
    return {
      ...this.counts,
      playedFrames: (l.played as number) ?? 0,
      silentFrames: (l.silent as number) ?? 0,
      rebuffers: (l.rebuffers as number) ?? 0,
      droppedFrames: (l.dropped as number) ?? 0,
      clicks: (l.clicks as number) ?? 0,
      maxStep: (l.maxStep as number) ?? 0,
      bufferedMs,
      targetMs: this.targetMs,
      arrivalGapMs: this.maxGapMs,
      rate: (l.rate as number) ?? 1,
      latencyMs: bufferedMs + out,
      playing: Boolean(l.playing),
      muted: this.muted,
      contextState: this.ctx?.state ?? "none",
      contextTime: this.ctx?.currentTime ?? 0,
    };
  }
}
