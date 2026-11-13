// Main-thread side of the video worker: a VideoSink that forwards chunks to worker.ts,
// which decodes and draws on the canvas's OffscreenCanvas. The caller creates the Worker (so
// the bundler decides how the worker file is loaded), e.g. with Vite or esbuild:
// new Worker(new URL("./video-worker.js", import.meta.url), { type: "module" })
import type {
  DecoderChoices,
  VideoChunk,
  VideoSink,
  VideoStats,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";

export interface WorkerVideoSinkOptions {
  onStats?: (s: VideoStats) => void;
  /** Remote frame size changed; the canvas's intrinsic size already follows it. */
  onResize?: (width: number, height: number) => void;
  /** The worker could not start (e.g. no 2d context on OffscreenCanvas). */
  onFatal?: (error: string) => void;
  statsIntervalMs?: number;
  /** From probeDecoders(): codec strings and hardware hints for the worker's decoders. */
  decoders?: DecoderChoices;
  /** Settle submit() if the worker does not answer in time. Default 1000. */
  replyTimeoutMs?: number;
}

export class WorkerVideoSink implements VideoSink {
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    {
      resolve: () => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private readonly replyTimeoutMs: number;

  /**
   * Takes over `canvas` (transferControlToOffscreen): from now on only the worker draws on it.
   * Size it with CSS; its intrinsic size is set to the remote frame size by the worker.
   */
  constructor(
    private readonly worker: Worker,
    canvas: HTMLCanvasElement,
    private readonly opts: WorkerVideoSinkOptions = {},
  ) {
    this.replyTimeoutMs = opts.replyTimeoutMs ?? 1000;
    worker.onmessage = (e: MessageEvent<WorkerResponse>) =>
      this.onReply(e.data);
    const offscreen = canvas.transferControlToOffscreen();
    this.post(
      {
        type: "init",
        canvas: offscreen,
        statsIntervalMs: opts.statsIntervalMs,
        decoders: opts.decoders,
      },
      [offscreen],
    );
  }

  submit(chunks: VideoChunk[]): Promise<void> {
    if (this.closed) return Promise.resolve();
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve();
      }, this.replyTimeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      // Each chunk owns its buffer (VideoStream copies), so transferring is safe and free.
      this.post(
        { type: "decode", id, chunks },
        chunks.map((c) => c.data.buffer as ArrayBuffer),
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.post({ type: "close" });
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.resolve();
    }
    this.waiting.clear();
    // Let the worker close its decoder first; terminate shortly after.
    setTimeout(() => this.worker.terminate(), 100);
  }

  private post(m: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  private onReply(r: WorkerResponse): void {
    switch (r.type) {
      case "done": {
        const w = this.waiting.get(r.id);
        if (!w) return;
        this.waiting.delete(r.id);
        clearTimeout(w.timer);
        if (r.error) w.reject(new Error(r.error));
        else w.resolve();
        return;
      }
      case "stats":
        this.opts.onStats?.(r.stats);
        return;
      case "resize":
        this.opts.onResize?.(r.width, r.height);
        return;
      case "fatal":
        this.opts.onFatal?.(r.error);
        return;
    }
  }
}
