import fixtureRaw from "../fixtures/decoded/2026-11-12-browser-to-peer.json?raw";
import { describe, expect, it } from "vitest";
import {
  PunchHoleResponse_Failure,
  RendezvousError,
  RendezvousMessageSchema,
  PunchHoleResponseSchema,
  RegisterPeerResponseSchema,
  RelayResponseSchema,
  TransportClosedError,
  TransportTimeoutError,
  assignmentFromRelayResponse,
  buildPunchHoleRequest,
  buildRequestRelay,
  create,
  defaultRelayUrl,
  failureToError,
  fromBinary,
  idServerUrl,
  parseRendezvousMessage,
  relayUrl,
  requestRelay,
  toBinary,
} from "../src/index.js";
import type { CloseInfo, FrameTransport } from "../src/index.js";

interface FixtureFrame {
  seq: number;
  stream: "id" | "relay";
  direction: "browser->server" | "server->browser";
  len: number;
  hex: string;
  decoded: unknown;
}

const fixture: FixtureFrame[] = JSON.parse(fixtureRaw);
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const idFrames = fixture.filter((f) => f.stream === "id");
const capturedRequest = idFrames[0]!;
const capturedResponse = idFrames[1]!;
const KEY = "oV+rkiX2RtCRC4sY/ykOr/53kY8l6GfX4HtJpaxkBGk=";
const UUID = "93cfa714-5c5e-4e91-9d73-364175a15e9a";

/** Scripted transport: replays queued frames, records sends. */
class FakeTransport implements FrameTransport {
  sent: Uint8Array[] = [];
  closedFlag = false;
  readonly closed: Promise<CloseInfo> = new Promise(() => {});
  constructor(
    private inbox: Uint8Array[],
    private endBehaviour: "timeout" | "closed" = "timeout",
  ) {}
  send(frame: Uint8Array) {
    this.sent.push(frame);
  }
  async recv(timeoutMs?: number): Promise<Uint8Array> {
    const f = this.inbox.shift();
    if (f) return f;
    if (this.endBehaviour === "closed")
      throw new TransportClosedError({ code: 1006, reason: "", local: false });
    throw new TransportTimeoutError(timeoutMs ?? 0);
  }
  close() {
    this.closedFlag = true;
  }
}

const wrap = (
  union: Parameters<typeof create<typeof RendezvousMessageSchema>>[1],
) => toBinary(RendezvousMessageSchema, create(RendezvousMessageSchema, union));
const failureFrame = (failure: PunchHoleResponse_Failure, extra = {}) =>
  wrap({
    union: {
      case: "punchHoleResponse",
      value: create(PunchHoleResponseSchema, { failure, ...extra }),
    },
  });

describe("fixture 2026-11-12 (ID stream)", () => {
  it("captured request decodes to the expected PunchHoleRequest", () => {
    const m = parseRendezvousMessage(bytes(capturedRequest.hex));
    expect(m.union.case).toBe("punchHoleRequest");
    if (m.union.case !== "punchHoleRequest") return;
    expect(m.union.value.id).toBe("496345301");
    expect(m.union.value.natType).toBe(2); // SYMMETRIC
    expect(m.union.value.connType).toBe(0); // DEFAULT_CONN
    expect(m.union.value.licenceKey).toBe(KEY);
    expect(m.union.value.token).toBe("");
    expect(m.union.value.version).toBe("");
  });

  it("captured response decodes to the expected RelayResponse", () => {
    const m = parseRendezvousMessage(bytes(capturedResponse.hex));
    expect(m.union.case).toBe("relayResponse");
    if (m.union.case !== "relayResponse") return;
    const rr = m.union.value;
    expect(rr.uuid).toBe(UUID);
    expect(rr.relayServer).toBe("rustdesk-relay.example.net");
    expect(rr.version).toBe("1.5.3");
    expect(rr.refuseReason).toBe("");
    expect(rr.union.case).toBe("pk");
    expect(rr.union.value).toHaveLength(109); // 64-byte signature + 45-byte IdPk
  });

  it("buildPunchHoleRequest reproduces the browser's bytes exactly", () => {
    const built = buildPunchHoleRequest({
      peerId: "496345301",
      licenceKey: KEY,
    });
    expect(hex(built)).toBe(capturedRequest.hex);
  });

  it("buildRequestRelay reproduces the browser's hbbr first frame exactly", () => {
    const captured = fixture.find((f) => f.stream === "relay" && f.seq === 2)!;
    expect(hex(buildRequestRelay(UUID, KEY))).toBe(captured.hex);
  });

  it("omits token when empty, includes it when set", () => {
    const withToken = buildPunchHoleRequest({
      peerId: "1",
      licenceKey: "",
      token: "tok",
    });
    const m = fromBinary(RendezvousMessageSchema, withToken);
    expect(m.union.case === "punchHoleRequest" && m.union.value.token).toBe(
      "tok",
    );
  });

  it("relay-stream first frames decode as RequestRelay / SignedId / PublicKey", () => {
    const relay = fixture.filter((f) => f.stream === "relay");
    expect(relay.slice(0, 3).map((f) => f.len)).toEqual([87, 115, 86]);
    expect(Object.keys(relay[0]!.decoded as object)).toEqual(["requestRelay"]);
    expect(Object.keys(relay[1]!.decoded as object)).toEqual(["signedId"]);
    expect(Object.keys(relay[2]!.decoded as object)).toEqual(["publicKey"]);
    for (const f of relay.slice(3)) expect(f.decoded).toBeNull();
  });
});

describe("requestRelay with a fake transport", () => {
  it("replaying the fixture yields the expected RelayAssignment", async () => {
    const t = new FakeTransport([bytes(capturedResponse.hex)]);
    const a = await requestRelay(t, { peerId: "496345301", licenceKey: KEY });
    expect(hex(t.sent[0]!)).toBe(capturedRequest.hex);
    expect(a.uuid).toBe(UUID);
    expect(a.relayServer).toBe("rustdesk-relay.example.net");
    expect(a.version).toBe("1.5.3");
    expect(a.pk).toHaveLength(109);
  });

  it("ignores unrelated messages before the answer", async () => {
    const noise = wrap({
      union: {
        case: "registerPeerResponse",
        value: create(RegisterPeerResponseSchema, { requestPk: true }),
      },
    });
    const t = new FakeTransport([noise, bytes(capturedResponse.hex)]);
    expect(
      (await requestRelay(t, { peerId: "496345301", licenceKey: KEY })).uuid,
    ).toBe(UUID);
  });

  it.each([
    [PunchHoleResponse_Failure.ID_NOT_EXIST, "ID_NOT_EXIST"],
    [PunchHoleResponse_Failure.OFFLINE, "OFFLINE"],
    [PunchHoleResponse_Failure.LICENSE_MISMATCH, "LICENSE_MISMATCH"],
    [PunchHoleResponse_Failure.LICENSE_OVERUSE, "LICENSE_OVERUSE"],
  ] as const)("maps failure %s to %s", async (failure, code) => {
    const t = new FakeTransport([failureFrame(failure)]);
    await expect(
      requestRelay(t, { peerId: "1", licenceKey: "" }),
    ).rejects.toMatchObject({
      name: "RendezvousError",
      code,
      failure,
    });
  });

  it("other_failure becomes OTHER with the server text", async () => {
    const t = new FakeTransport([failureFrame(0, { otherFailure: "nope" })]);
    await expect(
      requestRelay(t, { peerId: "1", licenceKey: "" }),
    ).rejects.toMatchObject({
      code: "OTHER",
      message: "nope",
    });
  });

  it("unknown failure enum value becomes OTHER", () => {
    expect(failureToError(99).code).toBe("OTHER");
  });

  it("a PunchHoleResponse carrying an address is DIRECT_ONLY, not ID_NOT_EXIST", async () => {
    const t = new FakeTransport([
      failureFrame(0, {
        socketAddr: Uint8Array.of(1, 2, 3),
        pk: Uint8Array.of(9),
      }),
    ]);
    await expect(
      requestRelay(t, { peerId: "1", licenceKey: "" }),
    ).rejects.toMatchObject({
      code: "DIRECT_ONLY",
    });
  });

  it("RelayResponse without version -> PEER_VERSION_TOO_OLD; with refuse_reason -> REFUSED", () => {
    expect(() =>
      assignmentFromRelayResponse(create(RelayResponseSchema, { uuid: "u" })),
    ).toThrowError(expect.objectContaining({ code: "PEER_VERSION_TOO_OLD" }));
    expect(() =>
      assignmentFromRelayResponse(
        create(RelayResponseSchema, { refuseReason: "busy", version: "1" }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "REFUSED", message: "busy" }),
    );
  });

  it("times out with TIMEOUT", async () => {
    const t = new FakeTransport([]);
    const err = await requestRelay(
      t,
      { peerId: "1", licenceKey: "" },
      { timeoutMs: 50 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RendezvousError);
    expect(err.code).toBe("TIMEOUT");
  });

  it("transport close -> CLOSED; garbage frame -> PROTOCOL", async () => {
    await expect(
      requestRelay(new FakeTransport([], "closed"), {
        peerId: "1",
        licenceKey: "",
      }),
    ).rejects.toMatchObject({ code: "CLOSED" });
    await expect(
      requestRelay(new FakeTransport([Uint8Array.of(0xff, 0xff, 0xff)]), {
        peerId: "1",
        licenceKey: "",
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL" });
  });
});

describe("URL helpers", () => {
  it("idServerUrl", () => {
    expect(idServerUrl("rustdesk-id.example.net", true)).toBe(
      "wss://rustdesk-id.example.net:21118",
    );
    expect(idServerUrl("rustdesk-id.example.net:441", true)).toBe(
      "wss://rustdesk-id.example.net:443",
    );
    expect(idServerUrl("10.0.0.5:21116", false)).toBe("ws://10.0.0.5:21118");
  });
  it("relayUrl", () => {
    expect(relayUrl("rustdesk-relay.example.net", true)).toBe(
      "wss://rustdesk-relay.example.net:21119",
    );
    expect(relayUrl("rustdesk-relay.example.net:21117", true)).toBe(
      "wss://rustdesk-relay.example.net:21119",
    );
    expect(relayUrl("h:441", false)).toBe("ws://h:443");
  });
  it("defaultRelayUrl uses offset 3 on the ID server", () => {
    expect(defaultRelayUrl("h", true)).toBe("wss://h:21119");
    expect(defaultRelayUrl("h:441", true)).toBe("wss://h:444");
  });
  it("rejects IPv6, URLs, empty and bad ports", () => {
    expect(() => idServerUrl("[::1]:21116", true)).toThrow(/IPv6/);
    expect(() => idServerUrl("::1", true)).toThrow(/IPv6/);
    expect(() => relayUrl("fe80::1", true)).toThrow(/IPv6/);
    expect(() => idServerUrl("wss://h", true)).toThrow();
    expect(() => idServerUrl("", true)).toThrow();
    expect(() => idServerUrl("h:abc", true)).toThrow();
    expect(() => idServerUrl("h:65534", true)).toThrow(/range/);
  });
});
