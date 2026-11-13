// VideoStream driven by a real capture: routing, ordering, acks, display
// filtering, refresh on decoder trouble. The decoder itself is browser-only.
import raw from "../fixtures/decoded/2026-11-12-video-frames.json?raw";
import { describe, expect, it } from "vitest";
import {
  EncodedVideoFrameSchema,
  EncodedVideoFramesSchema,
  MessageSchema,
  MiscSchema,
  SupportedDecoding_PreferCodec,
  SwitchDisplaySchema,
  VideoFrameSchema,
  VideoStream,
  create,
  fromBinary,
  videoLoginOption,
  type Message,
  type VideoChunk,
  type VideoSink,
} from "../src/index.js";

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const fixture = JSON.parse(raw) as {
  entries: { kind: string; segment: string; codec?: string; hex: string }[];
};
const messages = fixture.entries.map((e) =>
  fromBinary(MessageSchema, bytes(e.hex)),
);
const videoCount = fixture.entries.filter(
  (e) => e.kind === "video_frame",
).length;

class FakeSink implements VideoSink {
  received: VideoChunk[][] = [];
  closed = false;
  /** Make the next submit() calls reject. */
  failNext = 0;
  submit(chunks: VideoChunk[]): Promise<void> {
    this.received.push(chunks);
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error("decode error"));
    }
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
  }
}

function fakeSession(currentDisplay = 0) {
  const sent: Message[] = [];
  return {
    sent,
    peerInfo: { currentDisplay },
    send: (m: Message) => sent.push(m),
    misc: () =>
      sent.map((m) =>
        m.union.case === "misc" ? m.union.value.union.case : "?",
      ),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("videoLoginOption", () => {
  it("declares VP9 + VP8, prefers VP9, nothing else", () => {
    const d = videoLoginOption().supportedDecoding!;
    expect(d.abilityVp9).toBe(1);
    expect(d.abilityVp8).toBe(1);
    expect(d.abilityAv1).toBe(0);
    expect(d.abilityH264).toBe(0);
    expect(d.abilityH265).toBe(0);
    expect(d.prefer).toBe(SupportedDecoding_PreferCodec.VP9);
    expect(d.i444).toBeUndefined();
  });
});

describe("VideoStream on the captured stream", () => {
  it("hands every frame to the sink in order, as owned chunks with µs timestamps, and acks each once", async () => {
    const sink = new FakeSink();
    const v = new VideoStream({ sink });
    const s = fakeSession();
    v.attach(s);
    for (const m of messages) v.handle(m);
    await flush();
    expect(sink.received).toHaveLength(videoCount);
    const codecs = sink.received.map((c) => c[0]!.codec);
    const fx = fixture.entries
      .filter((e) => e.kind === "video_frame")
      .map((e) => e.codec!.replace(/s$/, ""));
    expect(codecs).toEqual(fx);
    const first = sink.received[0]![0]!;
    expect(first.key).toBe(true);
    // Owned copy: not a view into the decoded message's buffer.
    expect(first.data.byteOffset).toBe(0);
    expect(first.data.buffer.byteLength).toBe(first.data.byteLength);
    const second = sink.received[1]![0]!;
    const pts = (
      fixture.entries.filter((e) => e.kind === "video_frame")[1] as unknown as {
        frames: { pts: string }[];
      }
    ).frames[0]!.pts;
    expect(second.timestampUs).toBe(Number(pts) * 1000); // pts is ms
    expect(s.misc().filter((c) => c === "videoReceived")).toHaveLength(
      videoCount,
    );
    expect(v.stats).toMatchObject({
      messages: videoCount,
      acks: videoCount,
      sinkErrors: 0,
      refreshes: 0,
      codec: "av1",
      display: 0,
    });
  });

  it("queues acks until attach (frames can arrive before connectSession resolves)", async () => {
    const sink = new FakeSink();
    const v = new VideoStream({ sink });
    const firstVideo = messages.find((m) => m.union.case === "videoFrame")!;
    v.onEvent({ type: "message", message: firstVideo });
    await flush();
    const s = fakeSession();
    v.attach(s);
    expect(s.misc()).toEqual(["videoReceived"]);
  });

  it("pipelined (default): acks when decode starts, the next frame waits for the previous decode", async () => {
    const releases: Array<() => void> = [];
    const sink: VideoSink = {
      submit: () => new Promise<void>((r) => releases.push(r)),
      close() {},
    };
    const v = new VideoStream({ sink });
    const s = fakeSession();
    v.attach(s);
    const vids = messages.filter((m) => m.union.case === "videoFrame");
    v.handle(vids[0]!);
    await flush();
    expect(s.misc()).toEqual(["videoReceived"]); // decoder idle: ack at once
    v.handle(vids[1]!);
    await flush();
    expect(s.misc()).toHaveLength(1); // frame 0 still decoding: frame 1 not acked yet
    expect(releases).toHaveLength(1);
    releases[0]!();
    await flush();
    expect(s.misc()).toEqual(["videoReceived", "videoReceived"]);
    expect(releases).toHaveLength(2);
  });

  it("after-decode: acks only after the sink settles (the 1.2.5 reference)", async () => {
    let release!: () => void;
    const sink: VideoSink = {
      submit: () => new Promise<void>((r) => (release = r)),
      close() {},
    };
    const v = new VideoStream({ sink, ackPolicy: "after-decode" });
    const s = fakeSession();
    v.attach(s);
    v.handle(messages.find((m) => m.union.case === "videoFrame")!);
    await flush();
    expect(s.sent).toHaveLength(0);
    release();
    await flush();
    expect(s.misc()).toEqual(["videoReceived"]);
  });

  it("on sink errors: still acks, sends refresh_video at most once per interval", async () => {
    let t = 0;
    const sink = new FakeSink();
    sink.failNext = 3;
    const v = new VideoStream({ sink, now: () => t, refreshIntervalMs: 1000 });
    const s = fakeSession();
    v.attach(s);
    const vids = messages.filter((m) => m.union.case === "videoFrame");
    v.handle(vids[0]!);
    v.handle(vids[1]!);
    await flush();
    t = 1500;
    v.handle(vids[2]!);
    await flush();
    // Pipelined: each ack goes out before its decode result is known.
    expect(s.misc()).toEqual([
      "videoReceived",
      "refreshVideo",
      "videoReceived",
      "videoReceived",
      "refreshVideo",
    ]);
    expect(v.stats.sinkErrors).toBe(3);
    expect(v.stats.refreshes).toBe(2);
  });

  it("drops (and acks) frames of other displays and codecs we do not decode", async () => {
    const sink = new FakeSink();
    const v = new VideoStream({ sink });
    const s = fakeSession(1); // showing display 1; the fixture is display 0
    v.attach(s);
    v.handle(messages.find((m) => m.union.case === "videoFrame")!);
    const rgb = create(MessageSchema, {
      union: {
        case: "videoFrame",
        value: { display: 1, union: { case: "rgb", value: {} } } as never,
      },
    });
    v.handle(rgb);
    await flush();
    expect(sink.received).toHaveLength(0);
    expect(s.misc()).toEqual(["videoReceived", "videoReceived"]);
    expect(v.stats).toMatchObject({
      droppedOtherDisplay: 1,
      droppedUnsupported: 1,
    });
  });

  it("follows the peer's switch_display and sends switch_display + capture_displays to switch", () => {
    const seen: number[] = [];
    const v = new VideoStream({
      sink: new FakeSink(),
      onSwitchDisplay: (d) => seen.push(d.width),
    });
    const s = fakeSession();
    v.attach(s);
    v.handle(
      create(MessageSchema, {
        union: {
          case: "misc",
          value: create(MiscSchema, {
            union: {
              case: "switchDisplay",
              value: create(SwitchDisplaySchema, {
                display: 0,
                width: 1920,
                height: 1080,
              }),
            },
          }),
        },
      }),
    );
    expect(seen).toEqual([1920]);
    v.switchDisplay(2);
    expect(v.stats.display).toBe(2);
    expect(s.misc()).toEqual(["switchDisplay", "captureDisplays"]);
    const cap = s.sent[1]!.union.value as {
      union: { value: { set: number[] } };
    };
    expect(cap.union.value.set).toEqual([2]);
  });

  it("closing (or the session closing) closes the sink and stops sending", async () => {
    const sink = new FakeSink();
    const v = new VideoStream({ sink });
    const s = fakeSession();
    v.attach(s);
    v.onEvent({
      type: "closed",
      closed: { kind: "local", message: "" },
    });
    expect(sink.closed).toBe(true);
    v.handle(messages.find((m) => m.union.case === "videoFrame")!);
    await flush();
    expect(s.sent).toHaveLength(0);
  });
});

describe("VideoStream, several displays at once", () => {
  const frame = (display: number, n: number) =>
    create(MessageSchema, {
      union: {
        case: "videoFrame",
        value: create(VideoFrameSchema, {
          display,
          union: {
            case: "vp9s",
            value: create(EncodedVideoFramesSchema, {
              frames: [
                create(EncodedVideoFrameSchema, {
                  data: new Uint8Array([display, n]),
                  key: n === 0,
                  pts: BigInt(n),
                }),
              ],
            }),
          },
        }),
      },
    });

  it("routes each display to its own sink, in order, acking every message once", async () => {
    const sinks = new Map([
      [0, new FakeSink()],
      [1, new FakeSink()],
    ]);
    const vs = new VideoStream({
      sink: new FakeSink(),
      sinkFor: (d) => sinks.get(d),
    });
    const s = fakeSession();
    vs.attach(s);
    for (let n = 0; n < 3; n++) for (const d of [0, 1]) vs.handle(frame(d, n));
    await flush();
    for (const d of [0, 1])
      expect(sinks.get(d)!.received.map((c) => [...c[0]!.data])).toEqual([
        [d, 0],
        [d, 1],
        [d, 2],
      ]);
    expect(s.misc().filter((m) => m === "videoReceived")).toHaveLength(6);
    expect(vs.stats.droppedOtherDisplay).toBe(0);
  });

  it("drops (and acks) a display that has no sink yet", async () => {
    const only = new FakeSink();
    const vs = new VideoStream({
      sink: new FakeSink(),
      sinkFor: (d) => (d === 0 ? only : undefined),
    });
    const s = fakeSession();
    vs.attach(s);
    vs.handle(frame(1, 0));
    vs.handle(frame(0, 0));
    await flush();
    expect(only.received).toHaveLength(1);
    expect(vs.stats.droppedOtherDisplay).toBe(1);
    expect(s.misc().filter((m) => m === "videoReceived")).toHaveLength(2);
  });

  it("a slow decode on one display does not hold up the other", async () => {
    let release!: () => void;
    const slow: VideoSink = {
      submit: () => new Promise<void>((r) => (release = r)),
      close: () => {},
    };
    const fast = new FakeSink();
    const vs = new VideoStream({
      sink: new FakeSink(),
      sinkFor: (d) => (d === 0 ? slow : fast),
    });
    vs.attach(fakeSession());
    vs.handle(frame(0, 0));
    vs.handle(frame(0, 1)); // waits behind the slow decode
    vs.handle(frame(1, 0));
    vs.handle(frame(1, 1));
    await flush();
    expect(fast.received).toHaveLength(2);
    release();
  });

  it("showDisplays sends switch_display for the first, then capture_displays{set: all}", () => {
    const vs = new VideoStream({
      sink: new FakeSink(),
      sinkFor: () => undefined,
    });
    const s = fakeSession();
    vs.attach(s);
    vs.showDisplays([1, 0]);
    expect(s.misc()).toEqual(["switchDisplay", "captureDisplays"]);
    const cap = s.sent[1]!.union.value as {
      union: { value: { set: number[] } };
    };
    expect(cap.union.value.set).toEqual([1, 0]);
    const sw = s.sent[0]!.union.value as {
      union: { value: { display: number } };
    };
    expect(sw.union.value.display).toBe(1);
    expect(vs.stats.display).toBe(1);
  });
});
