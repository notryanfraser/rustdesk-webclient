// Shared video types. Pure data: safe to import from Node, the main thread or a worker.
//
// Wire facts these rely on (verified):
// * the codec is the VideoFrame oneof case of each message; after a codec switch one stray
// frame of the old codec still arrives, so routing is per message, never "current codec";
// * EncodedVideoFrame.pts is milliseconds; WebCodecs timestamps are microseconds;
// * one VideoFrame can carry several EncodedVideoFrames, decoded in order.

/** Codecs the client decodes. Anything else the peer sends is dropped (and acked). */
export type VideoCodec = "vp9" | "vp8" | "av1" | "h264" | "h265";

/**
 * WebCodecs codec strings, 8-bit 4:2:0 (what the peer encodes unless asked for 4:4:4). The
 * defaults; probeDecoders() (probe.ts) picks the string this browser accepts. H.264 and H.265
 * arrive as Annex B (parameter sets in band), so they are configured without a description.
 */
export const CODEC_STRINGS: Record<VideoCodec, string> = {
  vp9: "vp09.00.41.08",
  vp8: "vp8",
  av1: "av01.0.08M.08",
  h264: "avc1.640033",
  h265: "hvc1.1.6.L153.B0",
};

/** How to configure the decoder of one codec, as found by probeDecoders(). */
export interface DecoderChoice {
  /** The WebCodecs codec string the browser accepted. */
  codec: string;
  /** The browser accepts this codec with hardwareAcceleration: "prefer-hardware". */
  hardware: boolean;
}

/** The codecs this browser decodes; a codec without an entry is not decodable. */
export type DecoderChoices = Partial<Record<VideoCodec, DecoderChoice>>;

/** One encoded frame, ready for a decoder. `data` is owned by the chunk (safe to transfer). */
export interface VideoChunk {
  codec: VideoCodec;
  key: boolean;
  /** Microseconds (pts * 1000). */
  timestampUs: number;
  /** Display index from VideoFrame.display. */
  display: number;
  data: Uint8Array;
}

/**
 * Where VideoStream sends chunks. `submit` gets all chunks of one VideoFrame message and
 * resolves once they are decoded (or dropped); VideoStream acks the message to the peer then,
 * so the peer's next frame waits for our decoder (that is the flow control). It should never
 * stay pending: implementations bound it with a timeout. A rejection means "decoder in trouble";
 * VideoStream still acks and asks the peer for a keyframe.
 */
export interface VideoSink {
  submit(chunks: VideoChunk[]): Promise<void>;
  close(): void;
}

/** Rendering/decoding statistics, reported about once a second by VideoPipeline. */
export interface VideoStats {
  /** Frames drawn in the last reporting interval, per second. */
  fps: number;
  /** Totals since start. */
  decoded: number;
  rendered: number;
  /** Decoded frames replaced by a newer one before they could be drawn. */
  droppedStale: number;
  /** Chunks dropped because the decoder needed a keyframe (start, codec change, after error). */
  droppedAwaitingKey: number;
  decodeErrors: number;
  /** submit() calls that hit the ack timeout instead of finishing. */
  ackTimeouts: number;
  /** Size of the last drawn frame (the remote display, in its pixels). */
  width: number;
  height: number;
  codec: VideoCodec | "";
  /**
   * How the current decoder was configured: "hardware" when the browser accepted
   * "prefer-hardware" for it, "software" when it refused, "" when unknown (no probe, or
   * the hardware decoder failed and the browser now chooses). WebCodecs does not report what
   * actually runs: a browser that ignores the hint shows as "hardware".
   */
  decoder: "hardware" | "software" | "";
  /** Mean time from submit to decoder output over the interval, ms. */
  decodeMs: number;
  /**
   * Mean luma (0-255) of what is on the canvas, from a 16x9 downscale; -1 before the first
   * frame. A diagnostic: a peer that cannot capture its screen streams solid black.
   */
  meanLuma: number;
}

export const EMPTY_STATS: VideoStats = {
  fps: 0,
  decoded: 0,
  rendered: 0,
  droppedStale: 0,
  droppedAwaitingKey: 0,
  decodeErrors: 0,
  ackTimeouts: 0,
  width: 0,
  height: 0,
  codec: "",
  decoder: "",
  decodeMs: 0,
  meanLuma: -1,
};

/** Main thread -> video worker. */
export type WorkerRequest =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      statsIntervalMs?: number;
      decoders?: DecoderChoices;
    }
  | { type: "decode"; id: number; chunks: VideoChunk[] }
  | { type: "close" };

/** Video worker -> main thread. */
export type WorkerResponse =
  | { type: "done"; id: number; error?: string }
  | { type: "stats"; stats: VideoStats }
  | { type: "resize"; width: number; height: number }
  | { type: "fatal"; error: string };
