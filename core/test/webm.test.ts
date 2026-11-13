// WebmWriter (recording): structure of the streamed file. Playback is checked with ffmpeg on
// a file built from the captured fixtures (scripts/webm-fixture.mjs).
import { describe, expect, it } from "vitest";
import {
  MessageSchema,
  MiscSchema,
  PermissionInfoSchema,
  PermissionInfo_Permission,
  WebmWriter,
  create,
  opusPacketMs,
  readRecordingPermission,
  recordStatusMessage,
} from "../src/index.js";

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const find = (hay: Uint8Array, needle: number[]) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

describe("WebmWriter", () => {
  const w = () =>
    new WebmWriter({
      video: { codec: "vp9", width: 1024, height: 768 },
      audio: { sampleRate: 48000, channels: 2 },
    });

  it("starts with an EBML header naming webm, then a Segment of unknown size", () => {
    const h = w().header();
    expect(hex(h.slice(0, 4))).toBe("1a45dfa3");
    expect(find(h, [...new TextEncoder().encode("webm")])).toBeGreaterThan(0);
    const seg = find(h, [0x18, 0x53, 0x80, 0x67]);
    expect(hex(h.slice(seg + 4, seg + 12))).toBe("01ffffffffffffff");
    expect(find(h, [...new TextEncoder().encode("V_VP9")])).toBeGreaterThan(0);
    expect(find(h, [...new TextEncoder().encode("A_OPUS")])).toBeGreaterThan(0);
    expect(find(h, [...new TextEncoder().encode("OpusHead")])).toBeGreaterThan(
      0,
    );
  });

  it("waits for a video keyframe: earlier video and audio are dropped", () => {
    const x = w();
    expect(x.video(0, false, new Uint8Array([1])).length).toBe(0);
    expect(x.audio(5, new Uint8Array([2])).length).toBe(0);
    expect(x.video(10, true, new Uint8Array([3])).length).toBeGreaterThan(0);
    expect(x.audio(15, new Uint8Array([4])).length).toBeGreaterThan(0);
  });

  it("opens a cluster at each keyframe; blocks carry timecodes relative to it", () => {
    const x = w();
    const first = x.video(1000, true, new Uint8Array([9, 9]));
    expect(hex(first.slice(0, 4))).toBe("1f43b675"); // Cluster
    const audio = x.audio(1040, new Uint8Array([7]));
    expect(hex(audio.slice(0, 1))).toBe("a3"); // SimpleBlock, same cluster
    // a3, size, track 0x82, int16 40, flags
    expect([...audio.slice(2, 6)]).toEqual([0x82, 0x00, 0x28, 0x80]);
    const delta = x.video(1100, false, new Uint8Array([1]));
    expect(hex(delta.slice(0, 1))).toBe("a3");
    expect([...delta.slice(2, 6)]).toEqual([0x81, 0x00, 0x64, 0x00]); // not a keyframe
    const next = x.video(2000, true, new Uint8Array([1]));
    expect(hex(next.slice(0, 4))).toBe("1f43b675");
  });

  it("keeps a track strictly increasing: frames in the same ms go 1 ms apart", () => {
    const x = w();
    x.video(5, true, new Uint8Array([1]));
    const same = x.video(5, false, new Uint8Array([2]));
    expect(new DataView(same.buffer, same.byteOffset).getInt16(3)).toBe(1); // 6 - cluster at 5
  });

  it("splits clusters before the int16 offset overflows", () => {
    const x = w();
    x.video(100, true, new Uint8Array([1]));
    const late = x.video(100 + 31_000, false, new Uint8Array([1]));
    expect(hex(late.slice(0, 4))).toBe("1f43b675");
  });

  it("lays audio out by packet duration: a burst arriving in one ms becomes 20 ms steps", () => {
    const x = w();
    x.video(0, true, new Uint8Array([1]));
    // TOC 0xfc: config 31 (CELT 20 ms), code 0 (one frame)
    const offsets = [0, 1, 2].map((i) => {
      const b = x.audio(100 + (i ? 0.4 : 0), new Uint8Array([0xfc, i]));
      return new DataView(b.buffer, b.byteOffset).getInt16(3);
    });
    expect(offsets).toEqual([100, 120, 140]);
    // a burst far ahead of real time: packets beyond 500 ms ahead are dropped, time never goes back
    const x2 = w();
    x2.video(0, true, new Uint8Array([1]));
    const kept = Array.from(
      { length: 40 },
      () => x2.audio(10, new Uint8Array([0xfc])).length > 0,
    ).filter(Boolean).length;
    expect(kept).toBe(26); // laid out at 10, 30, ... 510 ms: the 26th is the last within 500 ms of its arrival at 10
    // a gap (silence: no packets) re-anchors to the arrival time
    const after = x.audio(1000, new Uint8Array([0xfc]));
    expect(new DataView(after.buffer, after.byteOffset).getInt16(3)).toBe(1000);
  });

  it("reads Opus packet durations from the TOC byte", () => {
    expect(opusPacketMs(new Uint8Array([0xfc]))).toBe(20); // CELT 20 ms, 1 frame
    expect(opusPacketMs(new Uint8Array([0xf8 | 1]))).toBe(40); // 2 frames
    expect(opusPacketMs(new Uint8Array([0x08]))).toBe(20); // SILK config 1: 20 ms
    expect(opusPacketMs(new Uint8Array([0xfb, 0x03]))).toBe(60); // code 3, 3 frames
  });
});

describe("recording protocol", () => {
  it("client_record_status and the peer's Recording permission", () => {
    const m = recordStatusMessage(true);
    expect(m.union.case).toBe("misc");
    expect(
      (m.union.value as { union: { case: string; value: boolean } }).union,
    ).toEqual({ case: "clientRecordStatus", value: true });
    const perm = (permission: PermissionInfo_Permission, enabled: boolean) =>
      create(MessageSchema, {
        union: {
          case: "misc",
          value: create(MiscSchema, {
            union: {
              case: "permissionInfo",
              value: create(PermissionInfoSchema, { permission, enabled }),
            },
          }),
        },
      });
    expect(
      readRecordingPermission(perm(PermissionInfo_Permission.Recording, false)),
    ).toBe(false);
    expect(
      readRecordingPermission(perm(PermissionInfo_Permission.Recording, true)),
    ).toBe(true);
    expect(
      readRecordingPermission(perm(PermissionInfo_Permission.Audio, false)),
    ).toBeUndefined();
    expect(readRecordingPermission(create(MessageSchema, {}))).toBeUndefined();
  });
});
