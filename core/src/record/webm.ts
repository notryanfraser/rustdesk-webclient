// Streaming WebM writer for session recording: the peer's encoded VP9/VP8 video and Opus
// audio go into the file as they arrive. No re-encoding, original quality, and append-only output,
// so a recording can stream to disk (File System Access / OPFS) whatever its length.
//
// The file (Matroska subset WebM, https://www.matroska.org/technical/elements.html):
// EBML header (DocType "webm")
// Segment (size unknown: written as it grows)
// Info: TimestampScale 1 ms, MuxingApp / WritingApp
// Tracks: 1 video (V_VP9 / V_VP8, pixel size), 2 audio (A_OPUS, OpusHead, rate, channels)
// Cluster (size unknown) per video keyframe, or when the 16-bit block timecode would overflow:
// Timestamp, then SimpleBlocks in time order
// No Cues or Duration: players handle a live-style file (Chromium, Firefox, ffmpeg checked); seeking is slower than with an index.
//
// Times are milliseconds from the start of the recording, set by the caller (the app uses arrival
// time; AudioFrame carries no timestamp). Audio is then laid out by its own duration: the peer
// sends Opus packets in bursts, so arrival times bunch up (several 20 ms packets in one ms, which
// ffmpeg flagged as non-monotonic timestamps on a recording of the captured fixture). Each
// packet's length comes from its TOC byte (RFC 6716 3.1) and packets follow each other; arrival
// time re-anchors the audio after a real gap (the peer's noise gate stops packets during silence),
// and when the laid-out audio runs more than 500 ms ahead of arrival (a burst arriving faster than
// it plays, or the peer's clock running fast) packets are dropped rather than letting it drift
// from the video. Time never steps back: an earlier version re-anchored backwards, and ffmpeg
// read 94 audio packets of the fixture recording at one timestamp.

export type RecordedVideoCodec = "vp9" | "vp8";

export interface WebmTracks {
  video: { codec: RecordedVideoCodec; width: number; height: number };
  /** Omit for a recording without sound. */
  audio?: { sampleRate: number; channels: number };
}

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;
/** A block's timecode is relative to its cluster, as int16: stay well inside it. */
const MAX_CLUSTER_SPAN_MS = 30_000;
/** Audio arriving this much later than its laid-out time starts a new run (a gap: silence). */
const AUDIO_REANCHOR_MS = 200;
/** Laid-out audio may run at most this far ahead of arrival; beyond it packets are dropped. */
const AUDIO_MAX_AHEAD_MS = 500;

/** Duration of an Opus packet from its TOC byte (RFC 6716 3.1); 20 ms if unreadable. */
export function opusPacketMs(packet: Uint8Array): number {
  if (packet.length === 0) return 20;
  const toc = packet[0]!;
  const config = toc >> 3;
  const frameMs =
    config < 12
      ? [10, 20, 40, 60][config % 4]! // SILK
      : config < 16
        ? [10, 20][config % 2]! // hybrid
        : [2.5, 5, 10, 20][config % 4]!; // CELT
  const code = toc & 3;
  const frames =
    code === 0 ? 1 : code < 3 ? 2 : packet.length > 1 ? packet[1]! & 0x3f : 1;
  return frameMs * frames;
}

const UNKNOWN_SIZE = new Uint8Array([
  0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

/** EBML variable-length size. */
function vint(n: number): Uint8Array {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0]! |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error(`EBML size too large: ${n}`);
}

/** Element ID bytes (IDs are written with their marker bits, as in the spec's tables). */
function id(n: number): Uint8Array {
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.from(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function el(elementId: number, ...body: Uint8Array[]): Uint8Array {
  const data = concat(body);
  return concat([id(elementId), vint(data.length), data]);
}

function uint(elementId: number, n: number): Uint8Array {
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return el(elementId, Uint8Array.from(bytes.length ? bytes : [0]));
}

function float64(elementId: number, n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return el(elementId, b);
}

const text = (elementId: number, s: string) =>
  el(elementId, new TextEncoder().encode(s));

/** OpusHead (RFC 7845 5.1): the CodecPrivate of an A_OPUS track. */
function opusHead(sampleRate: number, channels: number): Uint8Array {
  const b = new Uint8Array(19);
  b.set(new TextEncoder().encode("OpusHead"));
  const v = new DataView(b.buffer);
  v.setUint8(8, 1); // version
  v.setUint8(9, channels);
  v.setUint16(10, 0, true); // pre-skip: the peer's stream starts mid-flow, nothing to skip
  v.setUint32(12, sampleRate, true);
  v.setInt16(16, 0, true); // output gain
  v.setUint8(18, 0); // mapping family 0: mono or stereo
  return b;
}

export class WebmWriter {
  private clusterStart: number | undefined;
  private readonly lastTime = new Map<number, number>();
  private started = false;
  /** Where the next audio packet goes (ms), by the durations of those before it. */
  private audioNext: number | undefined;

  constructor(private readonly tracks: WebmTracks) {}

  /** The file's first bytes: EBML header, the Segment's start, Info and Tracks. */
  header(): Uint8Array {
    const { video, audio } = this.tracks;
    const ebml = el(
      0x1a45dfa3,
      uint(0x4286, 1), // EBMLVersion
      uint(0x42f7, 1), // EBMLReadVersion
      uint(0x42f2, 4), // EBMLMaxIDLength
      uint(0x42f3, 8), // EBMLMaxSizeLength
      text(0x4282, "webm"), // DocType
      uint(0x4287, 4), // DocTypeVersion
      uint(0x4285, 2), // DocTypeReadVersion
    );
    const info = el(
      0x1549a966,
      uint(0x2ad7b1, 1_000_000), // TimestampScale: 1 ms
      text(0x4d80, "rustdesk-web"), // MuxingApp
      text(0x5741, "rustdesk-web"), // WritingApp
    );
    const videoTrack = el(
      0xae,
      uint(0xd7, VIDEO_TRACK), // TrackNumber
      uint(0x73c5, VIDEO_TRACK), // TrackUID
      uint(0x83, 1), // TrackType: video
      text(0x86, video.codec === "vp9" ? "V_VP9" : "V_VP8"), // CodecID
      el(0xe0, uint(0xb0, video.width), uint(0xba, video.height)), // Video: PixelWidth/Height
    );
    const audioTrack = audio
      ? el(
          0xae,
          uint(0xd7, AUDIO_TRACK),
          uint(0x73c5, AUDIO_TRACK),
          uint(0x83, 2), // TrackType: audio
          text(0x86, "A_OPUS"),
          el(0x63a2, opusHead(audio.sampleRate, audio.channels)), // CodecPrivate
          uint(0x56bb, 80_000_000), // SeekPreRoll: 80 ms, as Opus in WebM asks
          el(0xe1, float64(0xb5, audio.sampleRate), uint(0x9f, audio.channels)), // Audio
        )
      : new Uint8Array(0);
    const tracks = el(0x1654ae6b, videoTrack, audioTrack);
    return concat([ebml, id(0x18538067), UNKNOWN_SIZE, info, tracks]);
  }

  /**
   * A video frame at `timeMs`. Returns the bytes to append (empty while waiting for the first
   * keyframe: a recording must start on one).
   */
  video(timeMs: number, key: boolean, data: Uint8Array): Uint8Array {
    if (!this.started && !key) return new Uint8Array(0);
    this.started = true;
    return this.block(VIDEO_TRACK, timeMs, key, data, key);
  }

  /** An Opus packet that arrived at `timeMs` (dropped until the video has started). */
  audio(timeMs: number, data: Uint8Array): Uint8Array {
    if (!this.started || !this.tracks.audio) return new Uint8Array(0);
    if (
      this.audioNext === undefined ||
      timeMs > this.audioNext + AUDIO_REANCHOR_MS
    )
      this.audioNext = timeMs; // the start, or after a gap (silence)
    else if (timeMs < this.audioNext - AUDIO_MAX_AHEAD_MS)
      // Arriving faster than it plays (a catch-up burst, or the peer's clock running fast): the
      // audio would drift ahead of the video. Drop this packet; never step back in time.
      return new Uint8Array(0);
    const at = this.audioNext;
    this.audioNext += opusPacketMs(data);
    return this.block(AUDIO_TRACK, at, true, data, false);
  }

  private block(
    track: number,
    timeMs: number,
    key: boolean,
    data: Uint8Array,
    newClusterOnKey: boolean,
  ): Uint8Array {
    // A track's blocks move strictly forward (the two tracks may interleave a little): frames that
    // arrive in the same millisecond go 1 ms apart (ffmpeg flags equal timestamps).
    const last = this.lastTime.get(track);
    const t = Math.max(Math.round(timeMs), last === undefined ? 0 : last + 1);
    this.lastTime.set(track, t);
    const parts: Uint8Array[] = [];
    if (
      this.clusterStart === undefined ||
      (newClusterOnKey && t > this.clusterStart) ||
      t - this.clusterStart > MAX_CLUSTER_SPAN_MS
    ) {
      this.clusterStart = t;
      parts.push(id(0x1f43b675), UNKNOWN_SIZE, uint(0xe7, t)); // Cluster, Timestamp
    }
    const head = new Uint8Array(4);
    head[0] = 0x80 | track; // track number as a 1-byte vint
    new DataView(head.buffer).setInt16(1, t - this.clusterStart);
    head[3] = key ? 0x80 : 0x00; // flags: keyframe
    parts.push(el(0xa3, head, data)); // SimpleBlock
    return concat(parts);
  }
}
