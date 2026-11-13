// Clipboard: the zstd decoder against libzstd frames made like the peer's
// (fixtures/zstd-vectors.json from tools/vectors/gen_zstd.py), the size limit, and the messages.
import raw from "../fixtures/zstd-vectors.json?raw";
import { describe, expect, it } from "vitest";
import {
  ClipboardFormat,
  ClipboardSchema,
  ClipboardTooLargeError,
  MessageSchema,
  MultiClipboardsSchema,
  create,
  fromBinary,
  readClipboardMessage,
  textClipboardMessage,
  toBinary,
  zstdDecompress,
} from "../src/index.js";
import { sha256 } from "../src/session/sha256.js";

const fixture = JSON.parse(raw) as {
  libzstd: string;
  vectors: { name: string; size: number; sha256: string; frame: string }[];
};
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const frameOf = (name: string) =>
  b64(fixture.vectors.find((v) => v.name === name)!.frame);

describe("zstdDecompress (fzstd) vs libzstd", () => {
  it(`reproduces every libzstd ${fixture.libzstd} frame byte for byte`, () => {
    expect(fixture.vectors.length).toBe(16);
    for (const v of fixture.vectors) {
      const out = zstdDecompress(b64(v.frame));
      expect(out.length, v.name).toBe(v.size);
      expect(hex(sha256(out)), v.name).toBe(v.sha256);
    }
  });

  it("stops at the limit instead of producing everything", () => {
    const frame = frameOf("text-1m-l3");
    expect(() => zstdDecompress(frame, 100_000)).toThrow(
      ClipboardTooLargeError,
    );
    expect(zstdDecompress(frame, 1 << 20).length).toBe(1 << 20);
  });

  it("rejects garbage", () => {
    expect(() => zstdDecompress(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow();
  });
});

describe("clipboard messages", () => {
  it("reads a compressed text clipboard as the peer sends it", () => {
    const frame = frameOf("unicode-l3");
    const msg = create(MessageSchema, {
      union: {
        case: "clipboard",
        value: create(ClipboardSchema, {
          compress: true,
          content: frame,
          format: ClipboardFormat.Text,
        }),
      },
    });
    const wire = fromBinary(MessageSchema, toBinary(MessageSchema, msg));
    expect(readClipboardMessage(wire)).toBe(
      "Grüße 文字 😀 — tabs\tand\r\nCRLF",
    );
  });

  it("reads the first text entry of multi_clipboards and ignores other formats", () => {
    const msg = create(MessageSchema, {
      union: {
        case: "multiClipboards",
        value: create(MultiClipboardsSchema, {
          clipboards: [
            create(ClipboardSchema, {
              format: ClipboardFormat.ImagePng,
              content: new Uint8Array([137, 80]),
            }),
            create(ClipboardSchema, {
              format: ClipboardFormat.Text,
              content: new TextEncoder().encode("plain"),
            }),
          ],
        }),
      },
    });
    expect(readClipboardMessage(msg)).toBe("plain");
    const html = create(MessageSchema, {
      union: {
        case: "clipboard",
        value: create(ClipboardSchema, {
          format: ClipboardFormat.Html,
          content: new Uint8Array([60]),
        }),
      },
    });
    expect(readClipboardMessage(html)).toBeUndefined();
    expect(readClipboardMessage(create(MessageSchema, {}))).toBeUndefined();
  });

  it("writes text uncompressed, format Text, and it survives a round trip (1 MiB too)", () => {
    const big = "x".repeat(1 << 20) + "é";
    for (const text of ["hello", "", "Grüße 😀", big]) {
      const msg = textClipboardMessage(text);
      const cb = msg.union.value as {
        compress: boolean;
        format: ClipboardFormat;
      };
      expect(cb.compress).toBe(false);
      expect(cb.format).toBe(ClipboardFormat.Text);
      expect(
        readClipboardMessage(
          fromBinary(MessageSchema, toBinary(MessageSchema, msg)),
        ),
      ).toBe(text);
    }
  });

  it("an uncompressed clipboard over the limit is refused too", () => {
    const msg = textClipboardMessage("y".repeat(2000));
    expect(() => readClipboardMessage(msg, 1000)).toThrow(
      ClipboardTooLargeError,
    );
  });
});
