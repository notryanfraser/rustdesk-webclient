// VideoStream: the session side of video. Turns VideoFrame messages into VideoChunks for
// a VideoSink, acks each message (see flow control below), follows display switches, and
// asks the peer for a keyframe when decoding goes wrong. No browser APIs: runs (and is tested)
// in Node; the decoding/rendering half is VideoPipeline (pipeline.ts), usually in a worker.
//
// Upstream behaviour this follows (rustdesk 1.5.3):
// * Flow control. With LoginRequest.video_ack_required the peer's video service waits, per
// frame, until every web controller has sent Misc.video_received, polling 300 ms at a time
// for up to 3 s (src/server/video_service.rs 1009-1021, notify_video_frame_fetched_by_conn_id
// 150-171), then sleeps out the rest of its frame interval. So the ack is our backpressure,
// and its latency is part of every frame's period. The 1.2.5 reference acks after decoding
// (connection.ts 524-560); a native controller does not ack at all, the peer counts its frame
// as fetched when written to the socket (connection.rs 1079-1084). We ack when a message's
// decode starts ("pipelined", the default): immediately if the decoder is idle, otherwise
// once the previous message is decoded. That keeps at most one frame decoding while the
// peer encodes the next, instead of adding our decode time to each frame (measured
// against a 5120x1440 peer: about 20 ms of ack latency held it at 20 fps). A missing ack
// costs a 3 s stall, so every message is acked exactly once, even if dropped or failed.
// * Refresh. Misc.refresh_video restarts the capturer and encoder: a keyframe follows
// (connection.rs 3933-3941; observed). Used after decoder errors, rate-limited.
// * Displays. The controller switches with Misc.switch_display{display} followed by
// Misc.capture_displays{set: [display]} (1.5.3 src/ui_session_interface.rs switch_display
// 858-879; the second message is sent when not using texture rendering, which is our case:
// we want exactly one display captured). The peer announces a display change or switch with
// Misc.switch_display carrying the geometry (video_service.rs make_display_changed_msg
// 1414-1463), restarts its encoder ("SWITCH") and sends a keyframe at the new size.
// * Several displays at once: Misc.capture_displays{set: [...]} subscribes one
// connection to several displays (connection.rs capture_displays 4709-4767); each VideoFrame
// names its display. With `sinkFor`, every display gets its own sink and its own ordered
// chain. Acks need no change: video_received carries no display and releases every display
// of this connection that is waiting on a frame (video_service.rs
// notify_video_frame_fetched_by_conn_id 153-171), and a display waits only after sending one,
// so acking each message exactly once still works (an ack may release the other display a
// little early, never stall it).

import { create } from "@bufbuild/protobuf";
import {
  CaptureDisplaysSchema,
  MessageSchema,
  MiscSchema,
  SwitchDisplaySchema,
} from "../gen/message_pb.js";
import type { Message, Misc, SwitchDisplay } from "../gen/message_pb.js";
import type { SessionEvent } from "../session/session.js";
import type { VideoChunk, VideoCodec, VideoSink } from "./types.js";

/** What VideoStream needs from a Session. */
export interface VideoSessionLike {
  send(msg: Message): void;
  readonly peerInfo?: { currentDisplay: number };
}

export interface VideoStreamOptions {
  /** Where frames go when one display is shown (the default). */
  sink: VideoSink;
  /**
   * Several displays: the sink for a display's frames, or undefined to drop them (acked)
   * until it has one; then call refresh() for a keyframe. When given, frames of any display
   * are routed here instead of to `sink` (which then serves only as the default the caller
   * hands back), and showDisplays() picks which ones the peer sends.
   */
  sinkFor?: (display: number) => VideoSink | undefined;
  /** The peer announced a display change or switch (geometry in the message). */
  onSwitchDisplay?: (d: SwitchDisplay) => void;
  /** Minimum time between two refresh_video requests sent because of decode errors. Default 1000. */
  refreshIntervalMs?: number;
  /**
   * When to send Misc.video_received. "pipelined" (default): when the message's decode starts,
   * so at most one frame decodes while the peer encodes the next. "after-decode": when it is
   * decoded, as the 1.2.5 reference does (adds our decode time to every frame's period).
   */
  ackPolicy?: "pipelined" | "after-decode";
  /** Time source, for tests. */
  now?: () => number;
}

export interface VideoStreamStats {
  /** VideoFrame messages received. */
  messages: number;
  /** Chunks handed to the sink. */
  chunks: number;
  /** Encoded bytes handed to the sink (for bitrate). */
  bytes: number;
  /** Misc.video_received sent. */
  acks: number;
  /**
   * Sum over messages handed to the sink of the time from receipt to ack, ms. Divided by
   * ackTimed it is our share of each frame's round trip; the peer cannot send the next frame
   * sooner than this.
   */
  ackMsTotal: number;
  /** Messages counted in ackMsTotal (those handed to the sink). */
  ackTimed: number;
  /** Messages dropped: another display than the one shown. */
  droppedOtherDisplay: number;
  /** Messages dropped: a format we do not decode (rgb, yuv). */
  droppedUnsupported: number;
  /** Sink rejections (decoder trouble). */
  sinkErrors: number;
  /** refresh_video requests sent (by refresh() or after errors). */
  refreshes: number;
  /** Codec of the last message handed to the sink. */
  codec: VideoCodec | "";
  /** Display being shown (undefined until known). */
  display: number | undefined;
}

const CASE_TO_CODEC: Partial<Record<string, VideoCodec>> = {
  vp9s: "vp9",
  vp8s: "vp8",
  av1s: "av1",
  h264s: "h264",
  h265s: "h265",
};

export class VideoStream {
  private session: VideoSessionLike | undefined;
  private readonly outbox: Message[] = [];
  private chain: Promise<void> = Promise.resolve();
  /**
   * One decode chain per sink when routing with sinkFor: a sink's input stays strictly ordered
   * (also across a display switch that keeps the same sink), and sinks do not wait on each other.
   */
  private readonly chains = new Map<VideoSink, Promise<void>>();
  private lastRefresh = -Infinity;
  private closed = false;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly ackPolicy: "pipelined" | "after-decode";
  private readonly counts: VideoStreamStats = {
    messages: 0,
    chunks: 0,
    bytes: 0,
    acks: 0,
    ackMsTotal: 0,
    ackTimed: 0,
    droppedOtherDisplay: 0,
    droppedUnsupported: 0,
    sinkErrors: 0,
    refreshes: 0,
    codec: "",
    display: undefined,
  };

  constructor(private readonly opts: VideoStreamOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 1000;
    this.ackPolicy = opts.ackPolicy ?? "pipelined";
  }

  /**
   * Pass as `connectSession({ onEvent })` (with `autoAckVideo: false`) so frames that arrive
   * before connectSession resolves are not missed; acks are queued until attach().
   */
  readonly onEvent = (e: SessionEvent): void => {
    if (e.type === "message") this.handle(e.message);
    else this.close();
  };

  /** Start sending (acks, refreshes) through this session; flushes anything queued. */
  attach(session: VideoSessionLike): void {
    this.session = session;
    if (this.counts.display === undefined && session.peerInfo)
      this.counts.display = session.peerInfo.currentDisplay;
    for (const m of this.outbox.splice(0)) session.send(m);
  }

  get stats(): VideoStreamStats {
    return { ...this.counts };
  }

  /** Feed one session message. Non-video messages are ignored except Misc.switch_display. */
  handle(msg: Message): void {
    if (this.closed) return;
    const u = msg.union;
    if (u.case === "videoFrame") {
      this.counts.messages++;
      const vf = u.value;
      const codec = vf.union.case ? CASE_TO_CODEC[vf.union.case] : undefined;
      const shown = this.counts.display;
      if (!codec) {
        this.counts.droppedUnsupported++;
        this.ack();
        return;
      }
      const sink = this.opts.sinkFor
        ? this.opts.sinkFor(vf.display)
        : shown !== undefined && vf.display !== shown
          ? undefined
          : this.opts.sink;
      if (!sink) {
        this.counts.droppedOtherDisplay++;
        this.ack();
        return;
      }
      const frames = (vf.union.value as { frames: EncodedFrameLike[] }).frames;
      const chunks: VideoChunk[] = frames.map((f) => ({
        codec,
        key: f.key,
        timestampUs: Number(f.pts) * 1000,
        display: vf.display,
        // Own the bytes: the decoded message's fields can be views into one shared buffer,
        // and the sink may transfer them to a worker.
        data: f.data.slice(),
      }));
      this.counts.chunks += chunks.length;
      for (const c of chunks) this.counts.bytes += c.data.byteLength;
      this.counts.codec = codec;
      // Strictly in order, one message at a time: decoders need their input ordered, and the
      // peer only sends the next frame after our ack anyway.
      const received = this.now();
      const timedAck = () => {
        this.counts.ackMsTotal += this.now() - received;
        this.counts.ackTimed++;
        this.ack();
      };
      const fail = () => {
        this.counts.sinkErrors++;
        this.requestKeyframe();
      };
      const prev = this.opts.sinkFor
        ? (this.chains.get(sink) ?? Promise.resolve())
        : this.chain;
      let next: Promise<void>;
      if (this.ackPolicy === "pipelined") {
        // Ack when this message's decode starts, i.e. at once if the decoder is idle: the peer
        // encodes the next frame while we decode this one, and still waits whenever we fall
        // behind (the next message's ack waits for this decode to finish).
        next = prev.then(() => {
          timedAck();
          return sink.submit(chunks).then(undefined, fail);
        });
      } else {
        next = prev.then(() =>
          sink.submit(chunks).then(timedAck, () => {
            timedAck();
            fail();
          }),
        );
      }
      if (this.opts.sinkFor) this.chains.set(sink, next);
      else this.chain = next;
      return;
    }
    if (u.case === "misc" && u.value.union.case === "switchDisplay") {
      const d = u.value.union.value;
      this.counts.display = d.display;
      this.opts.onSwitchDisplay?.(d);
    }
  }

  /** Show another display: Misc.switch_display then Misc.capture_displays{set}. */
  switchDisplay(display: number): void {
    this.counts.display = display;
    this.sendMisc({
      case: "switchDisplay",
      value: create(SwitchDisplaySchema, { display }),
    });
    this.sendMisc({
      case: "captureDisplays",
      value: create(CaptureDisplaysSchema, { set: [display] }),
    });
  }

  /**
   * Show several displays at once (needs `sinkFor`): the first is the primary
   * (Misc.switch_display), then Misc.capture_displays{set} subscribes all of them.
   */
  showDisplays(displays: number[]): void {
    if (displays.length === 0) return;
    this.counts.display = displays[0];
    this.sendMisc({
      case: "switchDisplay",
      value: create(SwitchDisplaySchema, { display: displays[0] }),
    });
    this.sendMisc({
      case: "captureDisplays",
      value: create(CaptureDisplaysSchema, { set: displays }),
    });
  }

  /** Ask the peer for a fresh keyframe (Misc.refresh_video). Not rate-limited. */
  refresh(): void {
    this.lastRefresh = this.now();
    this.counts.refreshes++;
    this.sendMisc({ case: "refreshVideo", value: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.sink.close();
  }

  private requestKeyframe(): void {
    if (this.now() - this.lastRefresh >= this.refreshIntervalMs) this.refresh();
  }

  private ack(): void {
    this.counts.acks++;
    this.sendMisc({ case: "videoReceived", value: true });
  }

  private sendMisc(union: Misc["union"]): void {
    if (this.closed) return;
    const m = create(MessageSchema, {
      union: { case: "misc", value: create(MiscSchema, { union }) },
    });
    if (!this.session) {
      this.outbox.push(m);
      return;
    }
    try {
      this.session.send(m);
    } catch {
      // The session ended while a frame was decoding (SESSION_CLOSED): nothing left to ack.
      this.close();
    }
  }
}

interface EncodedFrameLike {
  data: Uint8Array;
  key: boolean;
  pts: bigint;
}
