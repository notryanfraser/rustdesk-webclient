// One session recording: the peer's encoded video (primary display) and Opus audio, as they
// arrive, into a WebM file (core WebmWriter: no re-encoding) that streams out through a download
// target (the picked file, or browser storage then the downloads folder, or memory for
// small recordings). Writes are serialized; a failing write, a video format change or the memory
// cap stops the recording, and what was written is still saved.
import { WebmWriter, type VideoChunk } from "@rustdesk-web/core";
import type { DownloadTarget } from "./files";

/** In-memory recordings (no File System Access, no OPFS) stop here. */
const MEMORY_CAP = 512 * 1024 * 1024;

export interface RecordingStatus {
  startedAt: number;
  bytes: number;
}

export class SessionRecorder {
  private readonly writer: WebmWriter;
  private readonly t0 = performance.now();
  private chain: Promise<void>;
  private stopped = false;
  private failed: Error | undefined;
  bytes = 0;
  readonly startedAt = Date.now();

  constructor(
    private readonly target: DownloadTarget,
    private readonly codec: "vp9" | "vp8",
    size: { width: number; height: number },
    audio: { sampleRate: number; channels: number } | undefined,
    /** The recording ended on its own: an error, a format change, the memory cap. */
    private readonly onStopped: (reason: string) => void,
  ) {
    this.writer = new WebmWriter({ video: { codec, ...size }, audio });
    this.chain = Promise.resolve();
    this.write(this.writer.header());
  }

  /** Encoded video of the recorded display, as the session hands it to the decoder. */
  video(chunks: VideoChunk[]): void {
    if (this.stopped) return;
    const t = performance.now() - this.t0;
    for (const c of chunks) {
      if (c.codec !== this.codec) {
        void this.finish(
          `the remote switched its video to ${c.codec.toUpperCase()}; the recording so far is saved`,
        );
        return;
      }
      this.write(this.writer.video(t, c.key, c.data));
    }
  }

  /** An Opus packet from the session. */
  audio(packet: Uint8Array): void {
    if (this.stopped) return;
    this.write(this.writer.audio(performance.now() - this.t0, packet));
  }

  /** Stop and save. `reason` set when the recording ended on its own. */
  async finish(reason?: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.chain; // never rejects: a failed write is kept in `failed`
    try {
      if (this.failed) throw this.failed;
      await this.target.finish();
    } catch (e) {
      await this.target.abort();
      reason = `the recording could not be saved: ${(e as Error).message}`;
    }
    if (reason) this.onStopped(reason);
  }

  private write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.bytes += bytes.length;
    if (this.target.kind === "memory" && this.bytes > MEMORY_CAP) {
      void this.finish(
        "the recording reached this browser's 512 MiB limit and was saved",
      );
      return;
    }
    this.chain = this.chain
      .then(() => (this.failed ? undefined : this.target.sink.write(0, bytes)))
      .catch((e: unknown) => {
        this.failed ??= e instanceof Error ? e : new Error(String(e));
        if (!this.stopped) void this.finish();
      });
  }
}
