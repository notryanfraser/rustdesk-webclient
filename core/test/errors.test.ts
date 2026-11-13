// Error taxonomy: every code in ERROR_CATALOG is produced here by real library code and run
// through describeError. Also covers the click-to-accept wait and zero-display peers.
import { describe, expect, it } from "vitest";
import {
  ERROR_CATALOG,
  LoginResponseSchema,
  MessageSchema,
  MiscSchema,
  PunchHoleResponse_Failure,
  PunchHoleResponseSchema,
  RelayResponseSchema,
  RendezvousError,
  RendezvousMessageSchema,
  RustDeskError,
  SecureError,
  SessionError,
  TransportClosedError,
  TransportError,
  TransportTimeoutError,
  connectSession,
  create,
  describeError,
  describeSessionClosed,
  idServerUrl,
  login,
  makeConnect,
  noDisplayError,
  requestRelay,
  type ConnectedSession,
  type ConnectSessionOptions,
  type Message,
  type SessionClosed,
  type WebSocketLike,
} from "../src/index.js";
import { Pipe, makeStubWorld, peerInfoResponse } from "./stub-peer.js";
import type { StubPeerOptions, StubWorld } from "./stub-peer.js";

const msg = (union: Message["union"]): Message =>
  create(MessageSchema, { union });
const loginError = (text: string) =>
  msg({
    case: "loginResponse",
    value: create(LoginResponseSchema, {
      union: { case: "error", value: text },
    }),
  });
const closeReason = (r: string) =>
  msg({
    case: "misc",
    value: create(MiscSchema, { union: { case: "closeReason", value: r } }),
  });
const rdv = (
  union: NonNullable<
    ReturnType<typeof create<typeof RendezvousMessageSchema>>["union"]
  >,
) => create(RendezvousMessageSchema, { union });

async function rejection(p: unknown | Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
}
const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("expected throw");
};

/** connectSession against a stub world; resolves to the world and the outcome. */
function connectTo(
  o: StubPeerOptions = {},
  over: Partial<ConnectSessionOptions> = {},
): { world: StubWorld; run: Promise<ConnectedSession> } {
  const world = makeStubWorld(o);
  const run = connectSession({
    idServer: "hbbs.test:441",
    serverKey: world.serverKey,
    peerId: world.peerId,
    password: "pw",
    pageIsHttps: true,
    connect: world.connect,
    timeouts: {
      handshakeMs: 100,
      loginMs: 100,
      rendezvousMs: 100,
      ...over.timeouts,
    },
    ...over,
  });
  return { world, run };
}
const failConnect = (
  o?: StubPeerOptions,
  over?: Partial<ConnectSessionOptions>,
) => rejection(connectTo(o, over).run);

/** Connect successfully, then let `act` break the channel; resolve to how the session closed. */
async function sessionClosedBy(
  act: (world: StubWorld, c: ConnectedSession) => void,
): Promise<SessionClosed> {
  const { world, run } = connectTo();
  const c = await run;
  act(world, c);
  return c.session.closed;
}

// --- fake WebSocket for the connect-level transport errors
class FakeWs implements WebSocketLike {
  binaryType = "blob";
  bufferedAmount = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onerror: WebSocketLike["onerror"] = null;
  onclose: WebSocketLike["onclose"] = null;
  static mode: "open" | "error" | "hang" = "open";
  constructor(readonly url: string) {
    if (FakeWs.mode === "open") queueMicrotask(() => this.onopen?.({}));
    if (FakeWs.mode === "error") queueMicrotask(() => this.onerror?.({}));
  }
  send() {}
  close(code = 1000, reason = "") {
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}
const wsConnect = makeConnect(FakeWs);

const SIGNED_ID_TEXT: Record<string, string> = {
  WRONG_PASSWORD: "Wrong Password",
  PASSWORD_REQUIRED: "Empty Password",
  TWO_FACTOR_REQUIRED: "2FA Required",
  WRONG_TWO_FACTOR: "Wrong 2FA Code",
  TOO_MANY_ATTEMPTS: "Too many wrong attempts",
  OFFLINE: "Offline",
  BLOCKED: "Your ip is blocked by the peer",
  NOT_ALLOWED: "Connection not allowed",
  PRIVACY_MODE: "Someone turns on privacy mode, exit",
  NO_SCREEN: "Wayland login screen is not supported",
  PEER_ERROR: "Some brand new peer error",
};

/** One producer per layer:code; the keys must equal ERROR_CATALOG exactly (checked below). */
const PRODUCERS: Record<string, () => Promise<unknown>> = {
  "config:BAD_SERVER_ADDRESS": async () =>
    thrown(() => idServerUrl("https://x", true)),

  "transport:CLOSED": async () => {
    FakeWs.mode = "open";
    const t = await wsConnect("wss://x");
    t.close();
    return rejection(t.recv());
  },
  "transport:TIMEOUT": async () => {
    FakeWs.mode = "open";
    const t = await wsConnect("wss://x");
    return rejection(t.recv(10));
  },
  "transport:CONNECT_FAILED": async () => {
    FakeWs.mode = "error";
    return rejection(wsConnect("wss://x"));
  },
  "transport:CONNECT_TIMEOUT": async () => {
    FakeWs.mode = "hang";
    return rejection(wsConnect("wss://x", { timeoutMs: 10 }));
  },

  ...Object.fromEntries(
    (
      [
        ["ID_NOT_EXIST", PunchHoleResponse_Failure.ID_NOT_EXIST],
        ["OFFLINE", PunchHoleResponse_Failure.OFFLINE],
        ["LICENSE_MISMATCH", PunchHoleResponse_Failure.LICENSE_MISMATCH],
        ["LICENSE_OVERUSE", PunchHoleResponse_Failure.LICENSE_OVERUSE],
      ] as const
    ).map(([code, failure]) => [
      `rendezvous:${code}`,
      () =>
        failConnect({
          idAnswer: rdv({
            case: "punchHoleResponse",
            value: create(PunchHoleResponseSchema, { failure }),
          }),
        }),
    ]),
  ),
  "rendezvous:OTHER": () =>
    failConnect({
      idAnswer: rdv({
        case: "punchHoleResponse",
        value: create(PunchHoleResponseSchema, {
          otherFailure: "server says no",
        }),
      }),
    }),
  "rendezvous:REFUSED": () =>
    failConnect({
      idAnswer: rdv({
        case: "relayResponse",
        value: create(RelayResponseSchema, {
          refuseReason: "busy",
          version: "1.5.3",
        }),
      }),
    }),
  "rendezvous:PEER_VERSION_TOO_OLD": () =>
    failConnect({
      idAnswer: rdv({
        case: "relayResponse",
        value: create(RelayResponseSchema, {}),
      }),
    }),
  "rendezvous:DIRECT_ONLY": () =>
    failConnect({
      idAnswer: rdv({
        case: "punchHoleResponse",
        value: create(PunchHoleResponseSchema, {
          socketAddr: Uint8Array.of(1, 2, 3, 4, 0, 0),
        }),
      }),
    }),
  "rendezvous:TIMEOUT": () =>
    rejection(
      requestRelay(
        new Pipe(),
        { peerId: "1", licenceKey: "k" },
        { timeoutMs: 15 },
      ),
    ),
  "rendezvous:CLOSED": () => {
    const p = new Pipe();
    p.onSend = () => p.remoteClose(1006, "gone");
    return rejection(requestRelay(p, { peerId: "1", licenceKey: "k" }));
  },
  "rendezvous:PROTOCOL": () => {
    const p = new Pipe();
    p.onSend = () => p.push(Uint8Array.of(0xff, 0xff));
    return rejection(requestRelay(p, { peerId: "1", licenceKey: "k" }));
  },

  "secure:NO_SERVER_KEY": () => failConnect({}, { serverKey: "" }),
  "secure:BAD_SERVER_KEY": () => failConnect({}, { serverKey: "not-a-key" }),
  "secure:NO_SERVER_PK": () =>
    failConnect({
      idAnswer: rdv({
        case: "relayResponse",
        value: create(RelayResponseSchema, { uuid: "u", version: "1.5.3" }),
      }),
    }),
  "secure:BAD_SIGNATURE": () =>
    failConnect(
      {},
      { serverKey: "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=" },
    ),
  "secure:ID_MISMATCH": () => failConnect({}, { peerId: "987654321" }),
  "secure:BAD_KEY": () => failConnect({ relay: "shortBoxKey" }),
  "secure:PROTOCOL": () => failConnect({ relay: "wrongFirstMessage" }),
  "secure:CLOSED": () => failConnect({ relay: "close" }),
  "secure:TIMEOUT": () =>
    failConnect({ relay: "silent" }, { timeouts: { handshakeMs: 20 } }),
  "secure:DECRYPT_FAILED": async () =>
    (await sessionClosedBy((w) => w.relay().push(new Uint8Array(40)))).error,
  "secure:BAD_FRAME": async () =>
    (await sessionClosedBy((w) => w.relay().push(new Uint8Array(3)))).error,
  "secure:COUNTER_EXHAUSTED": async () =>
    (
      await sessionClosedBy((w, c) => {
        const secure = (
          c.session as unknown as { secure: { recvCounter: number } }
        ).secure;
        secure.recvCounter = Number.MAX_SAFE_INTEGER;
        w.relay().push(new Uint8Array(40));
      })
    ).error,
  // Declared in SecureErrorCode but not raised anywhere yet: a failed SecureTransport re-throws
  // its original error (tests/crypto: "tampered ciphertext"). Built directly.
  "secure:FAILED": async () => new SecureError("FAILED"),

  "session:INVALID_ARGUMENT": () =>
    rejection(login(new Pipe(), { peerId: "", password: "pw" })),
  "session:PASSWORD_REQUIRED": () =>
    rejection(login(new Pipe(), { peerId: "1", password: "" })),
  ...Object.fromEntries(
    Object.entries(SIGNED_ID_TEXT).map(([code, text]) => [
      `session:${code}`,
      () => failConnect({ onLogin: (_lr, reply) => reply(loginError(text)) }),
    ]),
  ),
  "session:NO_PASSWORD_ACCESS": () =>
    failConnect(
      { onLogin: (_lr, reply) => reply(loginError("No Password Access")) },
      { timeouts: { loginMs: 50, approvalMs: 30 } },
    ),
  "session:PEER_CLOSED": () =>
    failConnect({ onLogin: (_lr, reply) => reply(closeReason("bye")) }),
  "session:TIMEOUT": () =>
    failConnect({ onLogin: () => {} }, { timeouts: { loginMs: 30 } }),
  "session:CLOSED": () => {
    const { world, run } = connectTo({
      onLogin: () => world.relay().remoteClose(),
    });
    return rejection(run);
  },
  "session:PROTOCOL": () => {
    const { world, run } = connectTo({
      onLogin: () => world.replyBytes(Uint8Array.of(0xff, 0xff, 0xff)),
    });
    return rejection(run);
  },
  "session:SESSION_CLOSED": async () => {
    const { run } = connectTo();
    const c = await run;
    await c.session.close();
    return thrown(() =>
      c.session.send(msg({ case: "misc", value: create(MiscSchema, {}) })),
    );
  },
  "session:NO_DISPLAY": () =>
    failConnect({ displays: 0 }, { requireDisplay: true }),
};

describe("error taxonomy", () => {
  const catalogKeys = Object.entries(ERROR_CATALOG).flatMap(([layer, codes]) =>
    Object.keys(codes).map((c) => `${layer}:${c}`),
  );

  it("PRODUCERS cover exactly the catalog", () => {
    expect(Object.keys(PRODUCERS).sort()).toEqual([...catalogKeys].sort());
  });

  it.each(catalogKeys)(
    "%s: produced by real code and described",
    async (key) => {
      const [layer, code] = key.split(":") as [string, string];
      const err = await PRODUCERS[key]!();
      expect(err, key).toBeInstanceOf(RustDeskError);
      const d = describeError(err);
      expect(d.layer).toBe(layer);
      expect(d.code).toBe(code);
      const entry = (
        ERROR_CATALOG as Record<
          string,
          Record<string, { userMessage: string; retryable: boolean }>
        >
      )[layer]![code]!;
      expect(d.userMessage).toBe(entry.userMessage);
      expect(d.retryable).toBe(entry.retryable);
      expect(d.userMessage.length).toBeGreaterThan(20);
      expect(typeof d.detail).toBe("string");
    },
  );

  it("user messages carry the wording the UI promised", () => {
    const m = (l: keyof typeof ERROR_CATALOG, c: string) =>
      (ERROR_CATALOG[l] as Record<string, { userMessage: string }>)[c]!
        .userMessage;
    expect(m("rendezvous", "ID_NOT_EXIST")).toMatch(
      /isn't registered with your server/,
    );
    expect(m("rendezvous", "LICENSE_MISMATCH")).toMatch(/Server key mismatch/);
    expect(m("secure", "BAD_SIGNATURE")).toMatch(/Server key mismatch/);
    expect(m("session", "TOO_MANY_ATTEMPTS")).toMatch(
      /Locked out for a minute/,
    );
    expect(m("session", "WRONG_PASSWORD")).toMatch(/Wrong password/);
  });

  it("existing classes keep their names, codes and Error ancestry", async () => {
    const a = await PRODUCERS["rendezvous:ID_NOT_EXIST"]!();
    expect(a).toBeInstanceOf(RendezvousError);
    expect((a as RendezvousError).name).toBe("RendezvousError");
    expect((a as RendezvousError).code).toBe("ID_NOT_EXIST");
    const s = await PRODUCERS["session:WRONG_PASSWORD"]!();
    expect(s).toBeInstanceOf(SessionError);
    expect((s as SessionError).peerMessage).toBe("Wrong Password");
    const c = await PRODUCERS["transport:CLOSED"]!();
    expect(c).toBeInstanceOf(TransportClosedError);
    expect(c).toBeInstanceOf(TransportError);
    expect((c as TransportClosedError).info.local).toBe(true);
    const t = await PRODUCERS["transport:TIMEOUT"]!();
    expect(t).toBeInstanceOf(TransportTimeoutError);
    expect((t as TransportTimeoutError).timeoutMs).toBe(10);
  });

  it("detail carries the peer's own words for peer-originated errors", async () => {
    const d = describeError(await PRODUCERS["session:PEER_ERROR"]!());
    expect(d.detail).toContain("Some brand new peer error");
  });

  it("describeError never throws and handles foreign values", () => {
    for (const v of [new Error("boom"), "str", 42, null, undefined, { a: 1 }]) {
      const d = describeError(v);
      expect(d.layer).toBe("unknown");
      expect(d.code).toBe("UNKNOWN");
      expect(d.retryable).toBe(false);
    }
    expect(describeError(new Error("boom")).detail).toBe("boom");
    // a RustDeskError with a code from the future still gets a generic description
    const d = describeError(new RustDeskError("session", "FROM_THE_FUTURE"));
    expect(d.code).toBe("FROM_THE_FUTURE");
    expect(d.userMessage).toMatch(/Something went wrong/);
  });

  it("retryable: wrong input is not, transient conditions are", () => {
    const r = (l: keyof typeof ERROR_CATALOG, c: string) =>
      (ERROR_CATALOG[l] as Record<string, { retryable: boolean }>)[c]!
        .retryable;
    expect(r("session", "WRONG_PASSWORD")).toBe(false);
    expect(r("rendezvous", "ID_NOT_EXIST")).toBe(false);
    expect(r("secure", "BAD_SIGNATURE")).toBe(false);
    expect(r("session", "TOO_MANY_ATTEMPTS")).toBe(true);
    expect(r("rendezvous", "OFFLINE")).toBe(true);
    expect(r("transport", "CLOSED")).toBe(true);
  });
});

describe("describeSessionClosed", () => {
  const closed = (kind: SessionClosed["kind"]): SessionClosed => ({
    kind,
    message: `m-${kind}`,
  });
  it("maps each close kind onto a session code; local is not an error", () => {
    expect(describeSessionClosed(closed("local"))).toBeUndefined();
    const want: Array<[SessionClosed["kind"], string]> = [
      ["peer", "PEER_CLOSED"],
      ["transport", "CLOSED"],
      ["timeout", "TIMEOUT"],
      ["error", "PROTOCOL"],
    ];
    for (const [kind, code] of want) {
      const d = describeSessionClosed(closed(kind))!;
      expect(d.layer).toBe("session");
      expect(d.code).toBe(code);
      expect(d.detail).toBe(`m-${kind}`);
      expect(d.userMessage).toBe(
        ERROR_CATALOG.session[code as "CLOSED"].userMessage,
      );
    }
  });

  it("works on a real session that the peer ended", async () => {
    const c = await sessionClosedBy((w) =>
      w.reply(closeReason("Closed manually by the peer")),
    );
    expect(describeSessionClosed(c)?.code).toBe("PEER_CLOSED");
    expect(describeSessionClosed(c)?.detail).toContain(
      "Closed manually by the peer",
    );
  });
});

describe("No Password Access is not terminal", () => {
  it("fires onWaitingForApproval once, keeps waiting, and succeeds when the peer later accepts", async () => {
    let waiting = 0;
    let reply!: (m: Message) => void;
    const { world, run } = connectTo(
      {
        onLogin: (_lr, r) => {
          reply = r;
          r(loginError("No Password Access"));
          setTimeout(() => r(loginError("No Password Access")), 5); // a repeat must not re-fire
          setTimeout(() => r(peerInfoResponse(1)), 40); // the person clicks Accept
        },
      },
      {
        onWaitingForApproval: () => waiting++,
        timeouts: { loginMs: 20, approvalMs: 500 },
      },
    );
    const c = await run; // login budget is 20 ms, the approval took 40: only the extension allows it
    expect(waiting).toBe(1);
    expect(c.login.waitedForApproval).toBe(true);
    expect(c.login.peerInfo.version).toBe("1.5.3");
    expect(reply).toBeDefined();
    expect(world.relay().info).toBeUndefined(); // channel left open
    await c.session.close();
  });

  it("without the callback it still waits", async () => {
    const { run } = connectTo(
      {
        onLogin: (_lr, r) => {
          r(loginError("No Password Access"));
          setTimeout(() => r(peerInfoResponse(1)), 30);
        },
      },
      { timeouts: { loginMs: 15, approvalMs: 500 } },
    );
    const c = await run;
    expect(c.login.waitedForApproval).toBe(true);
    await c.session.close();
  });

  it("ordinary logins do not report waiting", async () => {
    const { run } = connectTo();
    const c = await run;
    expect(c.login.waitedForApproval).toBe(false);
    await c.session.close();
  });

  it("a callback that throws does not abort the login", async () => {
    const { run } = connectTo(
      {
        onLogin: (_lr, r) => {
          r(loginError("No Password Access"));
          setTimeout(() => r(peerInfoResponse(1)), 10);
        },
      },
      {
        onWaitingForApproval: () => {
          throw new Error("ui bug");
        },
      },
    );
    const c = await run;
    expect(c.login.waitedForApproval).toBe(true);
    await c.session.close();
  });

  it("gives up with NO_PASSWORD_ACCESS when nobody accepts within approvalMs", async () => {
    const t0 = Date.now();
    const e = (await PRODUCERS[
      "session:NO_PASSWORD_ACCESS"
    ]!()) as SessionError;
    expect(e.code).toBe("NO_PASSWORD_ACCESS");
    expect(e.cause).toBeInstanceOf(TransportTimeoutError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it("the peer closing while we wait is a PEER_CLOSED, not a hang", async () => {
    const e = await failConnect({
      onLogin: (_lr, r) => {
        r(loginError("No Password Access"));
        setTimeout(() => r(closeReason("rejected")), 5);
      },
    });
    expect((e as SessionError).code).toBe("PEER_CLOSED");
  });
});

describe("zero-display peer", () => {
  it("logs in successfully and flags noDisplay (reference: error msgbox, no disconnect)", async () => {
    const { run } = connectTo({ displays: 0 });
    const c = await run;
    expect(c.login.noDisplay).toBe(true);
    expect(c.session.noDisplay).toBe(true);
    expect(c.session.peerInfo.displays.length).toBe(0);
    expect(c.session.isClosed).toBe(false);
    await c.session.close();
  });

  it("a normal peer has noDisplay=false", async () => {
    const { run } = connectTo({ displays: 2 });
    const c = await run;
    expect(c.login.noDisplay).toBe(false);
    expect(c.session.noDisplay).toBe(false);
    await c.session.close();
  });

  it("requireDisplay turns it into SessionError NO_DISPLAY and closes the channel politely", async () => {
    const { world, run } = connectTo({ displays: 0 }, { requireDisplay: true });
    const e = await rejection(run);
    expect((e as SessionError).code).toBe("NO_DISPLAY");
    expect(world.relay().info?.local).toBe(true);
    const last = world.received.at(-1)!;
    expect(last.union.case).toBe("misc"); // close_reason sent before dropping
  });

  it("noDisplayError() is a describable SessionError", () => {
    const d = describeError(noDisplayError());
    expect(d).toMatchObject({
      layer: "session",
      code: "NO_DISPLAY",
      retryable: true,
    });
  });
});
