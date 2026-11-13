import { describe, expect, it } from "vitest";
import {
  create,
  fromBinary,
  toBinary,
  RendezvousMessageSchema,
  MessageSchema,
  LoginRequestSchema,
  PunchHoleRequestSchema,
  CursorDataSchema,
  EncodedVideoFrameSchema,
} from "../src/index.js";

describe("protobuf round trips", () => {
  it("RendezvousMessage / PunchHoleRequest", () => {
    const msg = create(RendezvousMessageSchema, {
      union: {
        case: "punchHoleRequest",
        value: create(PunchHoleRequestSchema, {
          id: "123456789",
          licenceKey: "secret-key",
        }),
      },
    });
    const back = fromBinary(
      RendezvousMessageSchema,
      toBinary(RendezvousMessageSchema, msg),
    );
    expect(back.union.case).toBe("punchHoleRequest");
    if (back.union.case !== "punchHoleRequest") throw new Error("unreachable");
    expect(back.union.value.id).toBe("123456789");
    expect(back.union.value.licenceKey).toBe("secret-key");
  });

  it("Message / LoginRequest", () => {
    const msg = create(MessageSchema, {
      union: {
        case: "loginRequest",
        value: create(LoginRequestSchema, {
          username: "peer",
          password: new Uint8Array([1, 2, 3]),
          myId: "web-1",
          myName: "browser",
          videoAckRequired: true,
        }),
      },
    });
    const back = fromBinary(MessageSchema, toBinary(MessageSchema, msg));
    if (back.union.case !== "loginRequest") throw new Error("wrong case");
    expect(back.union.value.username).toBe("peer");
    expect(Array.from(back.union.value.password)).toEqual([1, 2, 3]);
    expect(back.union.value.myId).toBe("web-1");
    expect(back.union.value.videoAckRequired).toBe(true);
  });
});

describe("64-bit values", () => {
  const big = 9007199254740993n; // 2^53 + 1, not representable as a JS number

  it("plain int64 fields are bigint and survive exactly", () => {
    const f = create(EncodedVideoFrameSchema, { pts: big });
    const back = fromBinary(
      EncodedVideoFrameSchema,
      toBinary(EncodedVideoFrameSchema, f),
    );
    expect(typeof back.pts).toBe("bigint");
    expect(back.pts).toBe(big);
  });

  it("JS_STRING uint64 fields are decimal strings and survive exactly (CursorData.id)", () => {
    const c = create(CursorDataSchema, { id: "9007199254740993" });
    const back = fromBinary(CursorDataSchema, toBinary(CursorDataSchema, c));
    expect(typeof back.id).toBe("string");
    expect(back.id).toBe("9007199254740993");
  });

  it("JS_STRING uint64 oneof member (Message.cursor_id) survives exactly", () => {
    const m = create(MessageSchema, {
      union: { case: "cursorId", value: "9007199254740993" },
    });
    const back = fromBinary(MessageSchema, toBinary(MessageSchema, m));
    expect(back.union).toEqual({ case: "cursorId", value: "9007199254740993" });
  });

  it("u64 max on a bigint field", () => {
    const max = 18446744073709551615n;
    // LoginRequest.session_id is uint64 (field 10)
    const m = create(LoginRequestSchema, { sessionId: max });
    expect(
      fromBinary(LoginRequestSchema, toBinary(LoginRequestSchema, m)).sessionId,
    ).toBe(max);
  });
});

describe("wire compatibility with upstream field numbers", () => {
  it("decodes hand-built RendezvousMessage{punch_hole_request{id:'123'}}", () => {
    // RendezvousMessage.punch_hole_request = field 8, length-delimited: tag (8<<3)|2 = 0x42
    // PunchHoleRequest.id = field 1, length-delimited: tag 0x0a
    const bytes = new Uint8Array([0x42, 0x05, 0x0a, 0x03, 0x31, 0x32, 0x33]);
    const msg = fromBinary(RendezvousMessageSchema, bytes);
    expect(msg.union.case).toBe("punchHoleRequest");
    if (msg.union.case !== "punchHoleRequest") throw new Error("unreachable");
    expect(msg.union.value.id).toBe("123");
  });

  it("encodes to exactly those bytes", () => {
    const msg = create(RendezvousMessageSchema, {
      union: {
        case: "punchHoleRequest",
        value: create(PunchHoleRequestSchema, { id: "123" }),
      },
    });
    expect(Array.from(toBinary(RendezvousMessageSchema, msg))).toEqual([
      0x42, 0x05, 0x0a, 0x03, 0x31, 0x32, 0x33,
    ]);
  });

  it("decodes hand-built Message{cursor_id: 2^53+1} (field 14 varint, JS_STRING)", () => {
    // tag (14<<3)|0 = 0x70; varint of 2^53+1 = 81 80 80 80 80 80 80 10
    const bytes = new Uint8Array([
      0x70, 0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10,
    ]);
    const msg = fromBinary(MessageSchema, bytes);
    expect(msg.union).toEqual({ case: "cursorId", value: "9007199254740993" });
  });
});
