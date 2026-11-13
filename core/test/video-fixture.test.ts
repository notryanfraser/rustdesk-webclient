// Video fixture (captured from a live 1.5.3 peer on X11, 2026-11-12):
// the plaintext Message bytes must decode with our schemas, and the stream must show the
// codec negotiation the peer performs. Pixel decoding is browser-only.
import raw from "../fixtures/decoded/2026-11-12-video-frames.json?raw";
import { describe, expect, it } from "vitest";
import { MessageSchema, fromBinary, toBinary } from "../src/index.js";

interface Entry {
  segment: "vp9" | "vp8" | "av1";
  kind: string;
  codec?: string;
  frames?: { key: boolean; pts: string; len: number }[];
  decoded?: Record<string, unknown>;
  hex: string;
}
const fixture = JSON.parse(raw) as {
  displays: { width: number; height: number }[];
  entries: Entry[];
};
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const videos = fixture.entries.filter((e) => e.kind === "video_frame");

describe("captured VideoFrame fixture", () => {
  it("every entry decodes and re-encodes byte for byte", () => {
    for (const e of fixture.entries) {
      const m = fromBinary(MessageSchema, bytes(e.hex));
      expect(hex(toBinary(MessageSchema, m))).toBe(e.hex);
      if (e.kind === "video_frame") {
        expect(m.union.case).toBe("videoFrame");
        if (m.union.case !== "videoFrame") continue;
        expect(m.union.value.union.case).toBe(e.codec);
        const fs = (
          m.union.value.union.value as {
            frames: { key: boolean; data: Uint8Array }[];
          }
        ).frames;
        expect(fs.map((f) => [f.key, f.data.length])).toEqual(
          e.frames!.map((f) => [f.key, f.len]),
        );
      }
    }
  });

  it("no supported_decoding at login means VP9; the option switches codec", () => {
    const codecs = (seg: string) =>
      new Set(videos.filter((e) => e.segment === seg).map((e) => e.codec));
    expect(codecs("vp9")).toEqual(new Set(["vp9s"]));
    expect(codecs("vp8").has("vp8s")).toBe(true);
    expect(codecs("av1").has("av1s")).toBe(true);
  });

  it("each codec's stream starts with a keyframe, and a switch leaves at most one stale frame", () => {
    for (const seg of ["vp9", "vp8", "av1"] as const) {
      const segVideos = videos.filter((e) => e.segment === seg);
      const want = `${seg}s`;
      const firstNew = segVideos.findIndex((e) => e.codec === want);
      expect(firstNew).toBeLessThanOrEqual(1); // in-flight frame of the previous codec
      expect(segVideos[firstNew]!.frames![0]!.key).toBe(true);
      expect(segVideos.slice(firstNew).every((e) => e.codec === want)).toBe(
        true,
      );
    }
  });

  it("the peer reports usable encodings after each switch", () => {
    const enc = fixture.entries
      .filter((e) => e.kind === "misc.supportedEncoding")
      .map((e) => [e.segment, e.decoded!.vp8, e.decoded!.av1]);
    expect(enc).toEqual([
      ["vp9", false, false],
      ["vp8", true, false],
      ["av1", true, true],
    ]);
  });

  it("one display, odd-sized, as reported in peer_info", () => {
    expect(fixture.displays).toHaveLength(1);
    expect(fixture.displays[0]).toMatchObject({ width: 2700, height: 1598 });
  });
});
