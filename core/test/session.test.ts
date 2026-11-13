import { describe, expect, it } from "vitest";
import {
  HashSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  MessageSchema,
  MiscSchema,
  PeerInfoSchema,
  PunchHoleResponse_Failure,
  PunchHoleResponseSchema,
  RendezvousError,
  RendezvousMessageSchema,
  Session,
  SessionError,
  TestDelaySchema,
  TransportClosedError,
  TransportTimeoutError,
  VideoFrameSchema,
  buildLoginRequest,
  connectSession,
  create,
  fromBinary,
  hashPassword,
  hashPasswordSalted,
  login,
  loginErrorFromPeer,
  toBinary,
  type CloseInfo,
  type FrameTransport,
  type Message,
  type SessionClosed,
  type SessionErrorCode,
} from "../src/index.js";
import { sha256 } from "../src/session/sha256.js";

// ---------------------------------------------------------------- helpers

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const includes = (hay: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const enc = (m: Message) => toBinary(MessageSchema, m);
const msg = (union: Message["union"]): Message =>
  create(MessageSchema, { union });

const hashMsg = (salt = "SALT", challenge = "CHAL") =>
  msg({
    case: "hash",
    value: create(HashSchema, { salt, challenge }),
  });
const testDelay = (fromClient = false, time = 123n) =>
  msg({
    case: "testDelay",
    value: create(TestDelaySchema, { time, fromClient }),
  });
const loginError = (e: string) =>
  msg({
    case: "loginResponse",
    value: create(LoginResponseSchema, {
      union: { case: "error", value: e },
    }),
  });
const loginOk = () =>
  msg({
    case: "loginResponse",
    value: create(LoginResponseSchema, {
      union: {
        case: "peerInfo",
        value: create(PeerInfoSchema, {
          version: "1.5.3",
          platform: "Linux",
          hostname: "h",
        }),
      },
    }),
  });
const closeReason = (r: string) =>
  msg({
    case: "misc",
    value: create(MiscSchema, { union: { case: "closeReason", value: r } }),
  });
const videoFrame = () =>
  msg({
    case: "videoFrame",
    value: create(VideoFrameSchema, {}),
  });

/** Stand-in for SecureTransport: plaintext frames in, plaintext frames out. */
class FakeChannel implements FrameTransport {
  readonly sent: Uint8Array[] = [];
  closeCalls: Array<[number | undefined, string | undefined]> = [];
  readonly closed: Promise<CloseInfo>;
  private resolveClosed!: (i: CloseInfo) => void;
  private info: CloseInfo | undefined;
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Array<{
    resolve: (f: Uint8Array) => void;
    reject: (e: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];

  constructor() {
    this.closed = new Promise((r) => (this.resolveClosed = r));
  }
  get sentMessages(): Message[] {
    return this.sent.map((f) => fromBinary(MessageSchema, f));
  }
  /** Deliver one inbound message (or raw bytes). */
  push(m: Message | Uint8Array): void {
    const f = m instanceof Uint8Array ? m : enc(m);
    const w = this.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(f);
    } else this.queue.push(f);
  }
  /** The remote end drops the socket. */
  remoteClose(code = 1006, reason = ""): void {
    this.finish({ code, reason, local: false });
  }
  fail(e: Error): void {
    for (const w of this.waiters.splice(0)) w.reject(e);
  }
  send(f: Uint8Array): void {
    if (this.info) throw new TransportClosedError(this.info);
    this.sent.push(f);
  }
  recv(timeoutMs?: number): Promise<Uint8Array> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    if (this.info) return Promise.reject(new TransportClosedError(this.info));
    return new Promise((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { resolve, reject };
      if (timeoutMs !== undefined)
        w.timer = setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new TransportTimeoutError(timeoutMs));
        }, timeoutMs);
      this.waiters.push(w);
    });
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.finish({ code: code ?? 1000, reason: reason ?? "", local: true });
  }
  private finish(i: CloseInfo): void {
    if (this.info) return;
    this.info = i;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new TransportClosedError(i));
    }
    this.resolveClosed(i);
  }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- hashing

describe("sha256", () => {
  it("matches NIST/hashlib vectors across padding boundaries", () => {
    // python3: hashlib.sha256(bytes((i*7+3)%256 for i in range(n))).hexdigest()
    const vectors: Array<[number, string]> = [
      [0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      [1, "084fed08b978af4d7d196a7446a86b58009e636b611db16211b65a9aadff29c5"],
      [55, "e7313d333c272e639f790978283f9eb392e843d0f29b7016828bb1daa4aac70b"],
      [56, "4324d65f3c103567f5589c710bc08f8523f929a9272e3af36fc968e52abc6c27"],
      [63, "81c80242132f230c3bd41b3e63bbcff16107339549214a99614ff26664625055"],
      [64, "39e3d7b6b5d075d37d053ad89b24b41bef4f3c29760c84447cab3f3be1882241"],
      [65, "aacca6ff74fdbb296d165a45cecfa04e5127bc008770fbbdd48006f2d2fae95e"],
      [119, "9ce7368e4daf32341631b492e80359dc9f594b48453cd0dd5bf0b19279cc177e"],
      [120, "7836b787757e95e58b3ca5aec90b1b004e8deba1e50e9675af9cabf1a13a04b5"],
      [
        1000,
        "1e9bc38cbf860b9ec31918b065f9b52476c549a782e0e7990bed8ce3868d2371",
      ],
    ];
    for (const [n, want] of vectors) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256);
      expect(hex(sha256(data)), `n=${n}`).toBe(want);
    }
  });

  it("matches the FIPS 180-4 'abc' example", () => {
    expect(hex(sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("hashPassword", () => {
  // Computed independently with python3 hashlib from the reference formula
  // h1 = sha256(password_utf8 + salt_utf8); h2 = sha256(h1 + challenge_utf8)
  // (connection.ts login() 437-452; connection.rs verify_h1 2521).
  const vectors = [
    {
      password: "password",
      salt: "salt",
      challenge: "challenge",
      h1: "7a37b85c8918eac19a9089c0fa5a2ab4dce3f90528dcdeec108b23ddf3607b99",
      h2: "1ea65d82db76c42e7f674ee7f2c5df1626c8fc80b0d8f18fa61a07b083c16197",
    },
    {
      password: "",
      salt: "",
      challenge: "",
      h1: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      h2: "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456",
    },
    {
      password: "hunter2",
      salt: "Mn0qp2sVj8dQxA1fE3rTzKu5Lw7yBc9G",
      challenge: "aB3dE6",
      h1: "79277c998d27e46c4fa7e61790a3efd8cfece3d0492eab1fb9fde22fff6211e6",
      h2: "190799c39fa18f3f3c2be815ac99801ef2b23a3e55fd50cd6178e7f8fce64987",
    },
    {
      password: "pässwörd-日本語",
      salt: "sält-☃",
      challenge: "chäll",
      h1: "3522286dc81cf64c07950e1a188ec8ced62a127e032fd983cc0de4acc9570d79",
      h2: "f728b74e43f1780b18609c0ebec5557a6c271fa3ccfd387292532ade9b6b20e0",
    },
    {
      password: "a".repeat(100),
      salt: "b".repeat(55),
      challenge: "c".repeat(6),
      h1: "b20c2980757be42de06f54a71cc0cde2c0243bc096abf4522537f983481e9d6f",
      h2: "70dce0de13d90f5d32fd8cf4e45a476ea0bdd83e997dea4e46447b171381faa8",
    },
    {
      password: "x".repeat(55),
      salt: "",
      challenge: "",
      h1: "d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072",
      h2: "c21e94934b92308a9d098538dcfc3c1cf81776f1388b9597eda61a8724ceefcf",
    },
    {
      password: "y".repeat(56),
      salt: "",
      challenge: "",
      h1: "4877e564e5e36e367c7c8d59670774becd3350610b6df4c399c9fa9b66da5813",
      h2: "606bc627be7dc51f5b50725eb3fcefa1d8498d3ec29baef1d1db8b2ddcb6931e",
    },
  ];

  it("is byte-exact against independent vectors", () => {
    for (const v of vectors) {
      expect(hex(hashPasswordSalted(v.password, v.salt))).toBe(v.h1);
      expect(hex(hashPassword(v.password, v.salt, v.challenge))).toBe(v.h2);
    }
  });

  it("accepts bytes as well as strings and always yields 32 bytes", () => {
    const v = vectors[2]!;
    const h = hashPassword(utf8(v.password), utf8(v.salt), utf8(v.challenge));
    expect(h.length).toBe(32);
    expect(hex(h)).toBe(v.h2);
  });
});

// ---------------------------------------------------------------- LoginRequest

describe("buildLoginRequest", () => {
  const base = {
    peerId: "496345301",
    password: "s3cret-Pa55",
    hash: { salt: "SALT", challenge: "CHAL" },
  };

  it("sets the reference fields plus my_platform, and nothing else", () => {
    const m = buildLoginRequest(base);
    expect(m.union.case).toBe("loginRequest");
    const lr = fromBinary(MessageSchema, enc(m)).union.value as ReturnType<
      typeof create<typeof LoginRequestSchema>
    >;
    expect(lr.username).toBe("496345301");
    expect(lr.myId).toBe("web");
    expect(lr.myName).toBe("web");
    expect(lr.myPlatform).toBe("Web");
    expect(lr.videoAckRequired).toBe(true);
    expect(lr.version).toBe("");
    expect(lr.option).toBeUndefined();
    expect(lr.osLogin).toBeUndefined();
    expect(lr.sessionId).toBe(0n);
    expect(lr.union.case).toBeUndefined(); // plain remote-desktop login
    expect(lr.hwid.length).toBe(0);
    expect(lr.avatar).toBe("");
    expect(hex(lr.password)).toBe(
      hex(hashPassword(base.password, "SALT", "CHAL")),
    );
  });

  it("never puts the plain-text password (or its single hash) on the wire", () => {
    const bytes = enc(buildLoginRequest(base));
    const contains = (needle: Uint8Array) => includes(bytes, needle);
    expect(contains(utf8(base.password))).toBe(false);
    expect(contains(hashPasswordSalted(base.password, "SALT"))).toBe(false);
    expect(contains(hashPassword(base.password, "SALT", "CHAL"))).toBe(true);
  });

  it("honours overrides", () => {
    const m = buildLoginRequest({
      ...base,
      myId: "me",
      myName: "Me",
      myPlatform: "X",
      version: "1.2.5",
      videoAckRequired: false,
    });
    const lr = m.union.value as {
      myId: string;
      myName: string;
      myPlatform: string;
      version: string;
      videoAckRequired: boolean;
    };
    expect([lr.myId, lr.myName, lr.myPlatform, lr.version]).toEqual([
      "me",
      "Me",
      "X",
      "1.2.5",
    ]);
    expect(lr.videoAckRequired).toBe(false);
  });

  it("rejects empty password / peer id", () => {
    expect(() => buildLoginRequest({ ...base, password: "" })).toThrow(
      SessionError,
    );
    expect(() => buildLoginRequest({ ...base, peerId: "" })).toThrow(
      SessionError,
    );
  });
});

// ---------------------------------------------------------------- login

const opts = { peerId: "496345301", password: "pw", timeoutMs: 200 };

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
}

describe("login", () => {
  it("Hash -> LoginRequest -> peer_info; answers TestDelay on the way; keeps pre-login messages", async () => {
    const ch = new FakeChannel();
    const early = msg({
      case: "misc",
      value: create(MiscSchema, {
        union: {
          case: "audioFormat",
          value: { channels: 2, sampleRate: 48000 },
        },
      }),
    });
    ch.push(hashMsg("SALT", "CHAL"));
    ch.push(testDelay(false));
    ch.push(early);
    ch.push(loginOk());
    const r = await login(ch, opts);
    expect(r.peerInfo.version).toBe("1.5.3");
    expect(r.response.union.case).toBe("peerInfo");
    expect(r.keepalivesAnswered).toBe(1);
    expect(r.pending.map((m) => m.union.case)).toEqual(["misc"]);
    const sent = ch.sentMessages;
    expect(sent.map((m) => m.union.case)).toEqual([
      "loginRequest",
      "testDelay",
    ]);
    const lr = sent[0]!.union.value as {
      password: Uint8Array;
      username: string;
    };
    expect(lr.username).toBe("496345301");
    expect(hex(lr.password)).toBe(hex(hashPassword("pw", "SALT", "CHAL")));
    expect(ch.closeCalls).toEqual([]); // success leaves the channel open
  });

  it("does not echo TestDelay with from_client=true", async () => {
    const ch = new FakeChannel();
    ch.push(testDelay(true));
    ch.push(loginOk());
    const r = await login(ch, opts);
    expect(r.keepalivesAnswered).toBe(0);
    expect(ch.sent.length).toBe(0);
  });

  it("answers a second Hash with a fresh LoginRequest", async () => {
    const ch = new FakeChannel();
    ch.push(hashMsg("S1", "C1"));
    ch.push(hashMsg("S2", "C2"));
    ch.push(loginOk());
    await login(ch, opts);
    const pws = ch.sentMessages.map((m) =>
      hex((m.union.value as { password: Uint8Array }).password),
    );
    expect(pws).toEqual([
      hex(hashPassword("pw", "S1", "C1")),
      hex(hashPassword("pw", "S2", "C2")),
    ]);
  });

  it("maps Wrong Password to WRONG_PASSWORD, says goodbye and closes", async () => {
    const ch = new FakeChannel();
    ch.push(hashMsg());
    ch.push(loginError("Wrong Password"));
    const e = (await rejection(login(ch, opts))) as SessionError;
    expect(e).toBeInstanceOf(SessionError);
    expect(e.code).toBe("WRONG_PASSWORD");
    expect(e.peerMessage).toBe("Wrong Password");
    expect(ch.sentMessages.map((m) => m.union.case)).toEqual([
      "loginRequest",
      "misc",
    ]);
    expect(ch.closeCalls.length).toBe(1);
  });

  it("maps every peer error string", () => {
    const table: Array<[string, SessionErrorCode]> = [
      ["Wrong Password", "WRONG_PASSWORD"],
      ["Empty Password", "PASSWORD_REQUIRED"],
      ["No Password Access", "NO_PASSWORD_ACCESS"],
      ["2FA Required", "TWO_FACTOR_REQUIRED"],
      ["Wrong 2FA Code", "WRONG_TWO_FACTOR"],
      ["Too many wrong attempts", "TOO_MANY_ATTEMPTS"],
      ["Too many wrong attempts for IPv6 prefix /64", "TOO_MANY_ATTEMPTS"],
      ["Please try 1 minute later", "TOO_MANY_ATTEMPTS"],
      ["Offline", "OFFLINE"],
      ["Your ip is blocked by the peer", "BLOCKED"],
      ["Your ID is blocked by the peer", "BLOCKED"],
      ["Connection not allowed", "NOT_ALLOWED"],
      ["No permission of file transfer", "NOT_ALLOWED"],
      ["Supported only in the installed version.", "NOT_ALLOWED"],
      ["Someone turns on privacy mode, exit", "PRIVACY_MODE"],
      ["Wayland login screen is not supported", "NO_SCREEN"],
      [
        'Unsupported display server type "tty", x11 or wayland expected',
        "NO_SCREEN",
      ],
      ["Desktop none", "NO_SCREEN"],
      ["something new", "PEER_ERROR"],
    ];
    for (const [text, code] of table) {
      const e = loginErrorFromPeer(text);
      expect(e.code, text).toBe(code);
      expect(e.peerMessage).toBe(text);
    }
  });

  it("times out when the peer never answers the LoginRequest", async () => {
    const ch = new FakeChannel();
    ch.push(hashMsg());
    const e = (await rejection(
      login(ch, { ...opts, timeoutMs: 30 }),
    )) as SessionError;
    expect(e.code).toBe("TIMEOUT");
    expect(ch.closeCalls.length).toBe(1);
  });

  it("ignores unexpected messages and keeps waiting", async () => {
    const ch = new FakeChannel();
    ch.push(hashMsg());
    ch.push(videoFrame());
    ch.push(msg({ case: undefined }));
    ch.push(loginOk());
    const r = await login(ch, opts);
    expect(r.pending.length).toBe(2);
  });

  it("reports a peer close_reason before the response", async () => {
    const ch = new FakeChannel();
    ch.push(hashMsg());
    ch.push(closeReason("Connection not allowed"));
    const e = (await rejection(login(ch, opts))) as SessionError;
    expect(e.code).toBe("PEER_CLOSED");
    expect(e.peerMessage).toBe("Connection not allowed");
  });

  it("reports CLOSED when the transport drops, PROTOCOL on garbage", async () => {
    const a = new FakeChannel();
    a.push(hashMsg());
    setTimeout(() => a.remoteClose(1006), 10);
    expect(((await rejection(login(a, opts))) as SessionError).code).toBe(
      "CLOSED",
    );

    const b = new FakeChannel();
    b.push(new Uint8Array([0xff, 0xff, 0xff]));
    expect(((await rejection(login(b, opts))) as SessionError).code).toBe(
      "PROTOCOL",
    );
  });

  it("rejects empty arguments before sending anything", async () => {
    const ch = new FakeChannel();
    const e = (await rejection(
      login(ch, { ...opts, password: "" }),
    )) as SessionError;
    expect(e.code).toBe("PASSWORD_REQUIRED");
    expect(ch.sent.length).toBe(0);
  });

  it("never leaks the password into error messages", async () => {
    const ch = new FakeChannel();
    ch.push(hashMsg());
    ch.push(loginError("Wrong Password"));
    const e = (await rejection(
      login(ch, { ...opts, password: "TOP-SECRET-PW" }),
    )) as SessionError;
    expect(`${e.message} ${e.stack} ${JSON.stringify(e)}`).not.toContain(
      "TOP-SECRET-PW",
    );
  });
});

// ---------------------------------------------------------------- Session

async function mkSession(
  o: ConstructorParameters<typeof Session>[2] = {},
  pending: Message[] = [],
) {
  const ch = new FakeChannel();
  ch.push(hashMsg());
  ch.push(loginOk());
  const r = await login(ch, opts);
  r.pending.push(...pending);
  ch.sent.length = 0;
  return { ch, s: new Session(ch, r, o) };
}

describe("Session", () => {
  it("echoes each TestDelay back unchanged and counts it", async () => {
    const { ch, s } = await mkSession();
    ch.push(testDelay(false, 111n));
    ch.push(testDelay(false, 222n));
    await tick();
    const sent = ch.sentMessages;
    expect(sent.map((m) => m.union.case)).toEqual(["testDelay", "testDelay"]);
    expect(sent.map((m) => (m.union.value as { time: bigint }).time)).toEqual([
      111n,
      222n,
    ]);
    expect(
      sent.every((m) => !(m.union.value as { fromClient: boolean }).fromClient),
    ).toBe(true);
    expect(s.stats.keepalivesAnswered).toBe(2);
    expect(s.stats.byType.testDelay).toBe(2);
    await s.close();
  });

  it("ignores TestDelay with from_client=true", async () => {
    const { ch, s } = await mkSession();
    ch.push(testDelay(true));
    await tick();
    expect(ch.sent.length).toBe(0);
    expect(s.stats.keepalivesAnswered).toBe(0);
    await s.close();
  });

  it("counts other messages by type, acks video, and emits events", async () => {
    const seen: string[] = [];
    const { ch, s } = await mkSession({
      onEvent: (e) => e.type === "message" && seen.push(e.message.union.case!),
    });
    ch.push(videoFrame());
    ch.push(videoFrame());
    ch.push(msg({ case: "cursorId", value: "5" }));
    await tick();
    expect(s.stats.messagesReceived).toBe(3);
    expect(s.stats.byType).toEqual({ videoFrame: 2, cursorId: 1 });
    expect(s.stats.videoAcksSent).toBe(2);
    expect(seen).toEqual(["videoFrame", "videoFrame", "cursorId"]);
    const acks = ch.sentMessages;
    expect(acks.length).toBe(2);
    const misc = acks[0]!.union.value as {
      union: { case: string; value: boolean };
    };
    expect(misc.union).toEqual({ case: "videoReceived", value: true });
    await s.close();
  });

  it("autoAckVideo:false sends nothing for video", async () => {
    const { ch, s } = await mkSession({ autoAckVideo: false });
    ch.push(videoFrame());
    await tick();
    expect(ch.sent.length).toBe(0);
    expect(s.stats.videoAcksSent).toBe(0);
    await s.close();
  });

  it("replays messages received during login to listeners", async () => {
    const seen: string[] = [];
    const { s } = await mkSession(
      {
        onEvent: (e) =>
          e.type === "message" && seen.push(e.message.union.case!),
      },
      [videoFrame()],
    );
    expect(seen).toEqual(["videoFrame"]);
    await s.close();
  });

  it("close(): sends close_reason, closes the socket, resolves 'local'; idempotent", async () => {
    const { ch, s } = await mkSession();
    const events: string[] = [];
    s.on((e) => events.push(e.type));
    const c = await s.close();
    expect(c.kind).toBe("local");
    expect(ch.sentMessages.map((m) => m.union.case)).toEqual(["misc"]);
    const miscMsg = ch.sentMessages[0]!.union.value as {
      union: { case: string; value: string };
    };
    expect(miscMsg.union).toEqual({ case: "closeReason", value: "" });
    expect(ch.closeCalls.length).toBeGreaterThanOrEqual(1);
    expect(await s.close()).toBe(c);
    expect(ch.sent.length).toBe(1);
    expect(events).toEqual(["closed"]);
    expect(s.isClosed).toBe(true);
    expect(() => s.send(testDelay())).toThrow(SessionError);
  });

  it("surfaces a peer close_reason as kind 'peer'", async () => {
    const { ch, s } = await mkSession();
    ch.push(closeReason("Closed manually by the peer"));
    const c = await s.closed;
    expect(c.kind).toBe("peer");
    expect(c.peerReason).toBe("Closed manually by the peer");
    expect(ch.closeCalls.length).toBeGreaterThanOrEqual(1);
    // no goodbye is sent back to a peer that is already closing (io_loop.rs:2356-2358)
    expect(ch.sent.length).toBe(0);
  });

  it("surfaces an unexpected socket close as kind 'transport'", async () => {
    const { ch, s } = await mkSession();
    ch.remoteClose(1006, "gone");
    const c = await s.closed;
    expect(c.kind).toBe("transport");
    expect(c.transport).toEqual({ code: 1006, reason: "gone", local: false });
  });

  it("times out after idleTimeoutMs without any frame", async () => {
    const { s } = await mkSession({ idleTimeoutMs: 30 });
    const c = await s.closed;
    expect(c.kind).toBe("timeout");
  });

  it("reports undecodable data as kind 'error'", async () => {
    const { ch, s } = await mkSession();
    ch.push(new Uint8Array([0xff, 0xff, 0xff]));
    const c = await s.closed;
    expect(c.kind).toBe("error");
    expect(c.error).toBeInstanceOf(Error);
  });

  it("events() yields messages then a single closed event, then ends", async () => {
    const { ch, s } = await mkSession();
    const it = s.events();
    ch.push(videoFrame());
    ch.push(closeReason("bye"));
    const got: string[] = [];
    let closed: SessionClosed | undefined;
    for await (const e of it) {
      if (e.type === "message") got.push(e.message.union.case!);
      else closed = e.closed;
    }
    expect(got).toEqual(["videoFrame"]);
    expect(closed?.kind).toBe("peer");
  });

  it("send() writes encrypted-channel frames; one reader keeps counters in step", async () => {
    const { ch, s } = await mkSession();
    s.send(testDelay(true, 9n));
    expect(ch.sentMessages.length).toBe(1);
    await s.close();
  });
});

// ---------------------------------------------------------------- connectSession

describe("connectSession", () => {
  it("propagates a RendezvousError unchanged and closes the ID socket", async () => {
    const closes: string[] = [];
    const id = new FakeChannel();
    id.push(
      toBinary(
        RendezvousMessageSchema,
        create(RendezvousMessageSchema, {
          union: {
            case: "punchHoleResponse",
            value: create(PunchHoleResponseSchema, {
              failure: PunchHoleResponse_Failure.ID_NOT_EXIST,
            }),
          },
        }),
      ),
    );
    const orig = id.close.bind(id);
    id.close = (c, r) => (closes.push("id"), orig(c, r));
    const urls: string[] = [];
    const e = await rejection(
      connectSession({
        idServer: "hbbs.example:441",
        serverKey: "k",
        peerId: "123456789",
        password: "pw",
        pageIsHttps: true,
        connect: async (url) => (urls.push(url), id),
      }),
    );
    expect(e).toBeInstanceOf(RendezvousError);
    expect((e as RendezvousError).code).toBe("ID_NOT_EXIST");
    expect(urls).toEqual(["wss://hbbs.example:443"]);
    expect(closes).toEqual(["id"]);
  });

  it("propagates connect failures unchanged", async () => {
    const boom = new Error("connect boom");
    const e = await rejection(
      connectSession({
        idServer: "hbbs.example",
        serverKey: "k",
        peerId: "1",
        password: "pw",
        pageIsHttps: false,
        connect: async () => {
          throw boom;
        },
      }),
    );
    expect(e).toBe(boom);
  });
});
