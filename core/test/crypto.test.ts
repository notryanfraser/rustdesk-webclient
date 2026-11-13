import fixtureRaw from "../fixtures/decoded/2026-11-12-browser-to-peer.json?raw";
import vectorsRaw from "../fixtures/crypto-vectors.json?raw";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  IdPkSchema,
  MessageSchema,
  RendezvousMessageSchema,
  SecureError,
  SecureTransport,
  TransportClosedError,
  TransportTimeoutError,
  assignmentFromRelayResponse,
  counterNonce,
  create,
  createKeyExchange,
  fromBinary,
  secureHandshake,
  toBinary,
  verifyPeerSignedId,
  verifyServerSignedIdPk,
} from "../src/index.js";
import type { CloseInfo, FrameTransport } from "../src/index.js";

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s);

interface Vectors {
  peerId: string;
  hbbs: { seed: string; pk: string; pkBase64: string };
  peerSign: { seed: string; pk: string };
  peerBox: { pk: string };
  ephemeral: { sk: string; pk: string };
  sessionKey: string;
  serverSignedIdPk: string;
  peerSignedId: string;
  publicKeyMessage: { asymmetricValue: string; symmetricValue: string };
  secretbox: {
    counter: number;
    nonce: string;
    plaintext: string;
    ciphertext: string;
  }[];
}
const V: Vectors = JSON.parse(vectorsRaw);

class MockTransport implements FrameTransport {
  sent: Uint8Array[] = [];
  closeInfo: CloseInfo | undefined;
  closed: Promise<CloseInfo>;
  private resolveClosed!: (i: CloseInfo) => void;
  constructor(public inbox: Uint8Array[] = []) {
    this.closed = new Promise((r) => (this.resolveClosed = r));
  }
  send(frame: Uint8Array) {
    if (this.closeInfo) throw new TransportClosedError(this.closeInfo);
    this.sent.push(frame);
  }
  async recv(timeoutMs?: number) {
    const f = this.inbox.shift();
    if (f) return f;
    if (this.closeInfo) throw new TransportClosedError(this.closeInfo);
    if (timeoutMs !== undefined) throw new TransportTimeoutError(timeoutMs);
    return new Promise<Uint8Array>(() => {});
  }
  close(code = 1000, reason = "") {
    if (this.closeInfo) return;
    this.closeInfo = { code, reason, local: true };
    this.resolveClosed(this.closeInfo);
  }
}

const messageBytes = (signedId: Uint8Array) =>
  toBinary(
    MessageSchema,
    create(MessageSchema, {
      union: { case: "signedId", value: { id: signedId } as never },
    }),
  );

/** rand that returns the vector's ephemeral secret key, then its session key. */
const vectorRand = () => {
  const queue = [bytes(V.ephemeral.sk), bytes(V.sessionKey)];
  return (n: number) => {
    const next = queue.shift();
    if (!next || next.length !== n) throw new Error("unexpected rand call");
    return next;
  };
};

async function expectSecureError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SecureError);
  expect((err as SecureError).code).toBe(code);
}

describe("known-answer vectors (generated with real libsodium via PyNaCl)", () => {
  it("verifies hbbs's signed IdPk", () => {
    const { peerSignPk } = verifyServerSignedIdPk(
      bytes(V.serverSignedIdPk),
      V.hbbs.pkBase64,
      V.peerId,
    );
    expect(hex(peerSignPk)).toBe(V.peerSign.pk);
  });

  it("verifies the peer's SignedId and yields the box key + advertised kx_version", () => {
    const r = verifyPeerSignedId(
      bytes(V.peerSignedId),
      bytes(V.peerSign.pk),
      V.peerId,
    );
    expect(hex(r.peerBoxPk)).toBe(V.peerBox.pk);
    expect(r.peerKxVersion).toBe(1);
  });

  it("reproduces PublicKey{asymmetric_value, symmetric_value} byte for byte", () => {
    const kx = createKeyExchange(bytes(V.peerBox.pk), vectorRand());
    expect(hex(kx.asymmetricValue)).toBe(V.publicKeyMessage.asymmetricValue);
    expect(hex(kx.symmetricValue)).toBe(V.publicKeyMessage.symmetricValue);
    expect(hex(kx.sessionKey)).toBe(V.sessionKey);
    expect(kx.symmetricValue.length).toBe(48);
  });

  it("derives the counter nonce little-endian, 8 bytes wide, zero padded", () => {
    for (const v of V.secretbox)
      expect(hex(counterNonce(v.counter))).toBe(v.nonce);
  });

  it("secretbox send reproduces the vectors at counters 1, 2, 3", () => {
    const inner = new MockTransport();
    const t = new SecureTransport(inner, bytes(V.sessionKey));
    for (const v of V.secretbox.slice(0, 3)) t.send(bytes(v.plaintext));
    expect(inner.sent.map(hex)).toEqual(
      V.secretbox.slice(0, 3).map((v) => v.ciphertext),
    );
    expect(t.counters).toEqual({ send: 3, recv: 0 });
  });

  it("secretbox recv opens the vectors at counters 1, 2, 3", async () => {
    const inner = new MockTransport(
      V.secretbox.slice(0, 3).map((v) => bytes(v.ciphertext)),
    );
    const t = new SecureTransport(inner, bytes(V.sessionKey));
    for (const v of V.secretbox.slice(0, 3))
      expect(hex(await t.recv())).toBe(v.plaintext);
    expect(t.counters).toEqual({ send: 0, recv: 3 });
  });

  it("handles counters above 2^32 and 2^40 (both directions)", async () => {
    for (const v of V.secretbox.slice(3)) {
      const inner = new MockTransport([bytes(v.ciphertext)]);
      const t = new SecureTransport(inner, bytes(V.sessionKey));
      const internals = t as unknown as {
        sendCounter: number;
        recvCounter: number;
      };
      internals.sendCounter = internals.recvCounter = v.counter - 1;
      t.send(bytes(v.plaintext));
      expect(hex(inner.sent[0]!)).toBe(v.ciphertext);
      expect(hex(await t.recv())).toBe(v.plaintext);
    }
  });

  it("secureHandshake end to end against the vectors", async () => {
    const relay = new MockTransport([messageBytes(bytes(V.peerSignedId))]);
    const t = await secureHandshake(
      relay,
      { pk: bytes(V.serverSignedIdPk) },
      { serverKey: V.hbbs.pkBase64, peerId: V.peerId, rand: vectorRand() },
    );
    // Exactly one frame sent: Message.public_key with the vector values, no kx_version.
    expect(relay.sent.length).toBe(1);
    const msg = fromBinary(MessageSchema, relay.sent[0]!);
    expect(msg.union.case).toBe("publicKey");
    if (msg.union.case !== "publicKey") throw new Error("unreachable");
    expect(hex(msg.union.value.asymmetricValue)).toBe(
      V.publicKeyMessage.asymmetricValue,
    );
    expect(hex(msg.union.value.symmetricValue)).toBe(
      V.publicKeyMessage.symmetricValue,
    );
    expect(msg.union.value.kxVersion).toBe(0);
    // And the returned transport is keyed with the session key.
    t.send(bytes(V.secretbox[0]!.plaintext));
    expect(hex(relay.sent[1]!)).toBe(V.secretbox[0]!.ciphertext);
  });
});

describe("captured fixture 2026-11-12 (real hbbs + real 1.5.3 peer)", () => {
  // We cannot decrypt the capture: the session key was random and never recorded. We can
  // verify the two signatures, which proves the key/ID/pk handling against real data.
  const frames: { seq: number; hex: string; decoded: any }[] =
    JSON.parse(fixtureRaw);
  const serverKey: string = frames[0]!.decoded.punchHoleRequest.licenceKey;
  const relayResp = fromBinary(RendezvousMessageSchema, bytes(frames[1]!.hex));
  if (relayResp.union.case !== "relayResponse") throw new Error("fixture");
  const assignment = assignmentFromRelayResponse(relayResp.union.value);
  const signedIdFrame = fromBinary(MessageSchema, bytes(frames[3]!.hex));
  if (signedIdFrame.union.case !== "signedId") throw new Error("fixture");
  const signedId = signedIdFrame.union.value.id;

  it("RelayResponse.pk verifies against the hbbs key", () => {
    expect(assignment.pk.length).toBe(109);
    const { peerSignPk } = verifyServerSignedIdPk(
      assignment.pk,
      serverKey,
      "496345301",
    );
    expect(peerSignPk.length).toBe(32);
    const r = verifyPeerSignedId(signedId, peerSignPk, "496345301");
    expect(signedId.length).toBe(111);
    expect(r.peerBoxPk.length).toBe(32);
    expect(r.peerKxVersion).toBe(1);
  });

  it("the captured browser PublicKey has the shape createKeyExchange produces", () => {
    const kx = createKeyExchange(
      verifyPeerSignedId(
        signedId,
        verifyServerSignedIdPk(assignment.pk, serverKey, "496345301")
          .peerSignPk,
        "496345301",
      ).peerBoxPk,
    );
    const captured = fromBinary(MessageSchema, bytes(frames[4]!.hex));
    if (captured.union.case !== "publicKey") throw new Error("fixture");
    expect(captured.union.value.asymmetricValue.length).toBe(
      kx.asymmetricValue.length,
    );
    expect(captured.union.value.symmetricValue.length).toBe(
      kx.symmetricValue.length,
    );
  });

  it("fails closed with a different server key", () => {
    expect(() =>
      verifyServerSignedIdPk(assignment.pk, V.hbbs.pkBase64, "496345301"),
    ).toThrow(SecureError);
  });
});

describe("fail closed: handshake", () => {
  const serverKey = V.hbbs.pkBase64;
  const run = (
    pk: Uint8Array,
    inbox: Uint8Array[],
    opts: { serverKey?: string; peerId?: string } = {},
  ) => {
    const relay = new MockTransport(inbox);
    const p = secureHandshake(
      relay,
      { pk },
      {
        serverKey: opts.serverKey ?? serverKey,
        peerId: opts.peerId ?? V.peerId,
        rand: vectorRand(),
      },
    );
    return { relay, p };
  };
  const good = [() => messageBytes(bytes(V.peerSignedId))];

  const assertClosedNothingSent = (relay: MockTransport) => {
    expect(relay.sent.length).toBe(0); // no PublicKey, nothing at all
    expect(relay.closeInfo?.local).toBe(true);
  };

  it("wrong server key", async () => {
    const other = btoa(String.fromCharCode(...nacl.sign.keyPair().publicKey));
    const { relay, p } = run(
      bytes(V.serverSignedIdPk),
      good.map((f) => f()),
      {
        serverKey: other,
      },
    );
    await expectSecureError(p, "BAD_SIGNATURE");
    assertClosedNothingSent(relay);
  });

  it("empty server key (no silent default to the public RustDesk key)", async () => {
    const { relay, p } = run(
      bytes(V.serverSignedIdPk),
      good.map((f) => f()),
      {
        serverKey: "",
      },
    );
    await expectSecureError(p, "NO_SERVER_KEY");
    assertClosedNothingSent(relay);
  });

  it("malformed server key", async () => {
    const { p } = run(bytes(V.serverSignedIdPk), [], { serverKey: "abc" });
    await expectSecureError(p, "BAD_SERVER_KEY");
  });

  it("hbbs sent no pk", async () => {
    const { relay, p } = run(
      new Uint8Array(0),
      good.map((f) => f()),
    );
    await expectSecureError(p, "NO_SERVER_PK");
    assertClosedNothingSent(relay);
  });

  it("tampered hbbs signature / payload", async () => {
    for (const i of [0, 63, 64, 100]) {
      const pk = bytes(V.serverSignedIdPk);
      pk[i] = pk[i]! ^ 1;
      const { relay, p } = run(
        pk,
        good.map((f) => f()),
      );
      await expectSecureError(p, "BAD_SIGNATURE");
      assertClosedNothingSent(relay);
    }
  });

  it("id mismatch (RelayResponse.pk names another peer)", async () => {
    const { relay, p } = run(
      bytes(V.serverSignedIdPk),
      good.map((f) => f()),
      {
        peerId: "123456789",
      },
    );
    await expectSecureError(p, "ID_MISMATCH");
    assertClosedNothingSent(relay);
  });

  const signIdPk = (
    seedHex: string,
    id: string,
    pk: Uint8Array,
  ): Uint8Array => {
    const sk = nacl.sign.keyPair.fromSeed(bytes(seedHex)).secretKey;
    return nacl.sign(toBinary(IdPkSchema, create(IdPkSchema, { id, pk })), sk);
  };

  it("wrong-length peer signing key in RelayResponse.pk", async () => {
    const hbbsSeed = V.hbbs.seed;
    const pk = signIdPk(hbbsSeed, V.peerId, new Uint8Array(31));
    const { relay, p } = run(
      pk,
      good.map((f) => f()),
    );
    await expectSecureError(p, "BAD_KEY");
    assertClosedNothingSent(relay);
  });

  it("SignedId: wrong signer, tampered, wrong id, wrong-length box key", async () => {
    const peerSeed = V.peerSign.seed;
    const hbbsSeed = V.hbbs.seed;
    const cases: [string, Uint8Array][] = [
      ["BAD_SIGNATURE", signIdPk(hbbsSeed, V.peerId, new Uint8Array(32))], // signed by wrong key
      ["ID_MISMATCH", signIdPk(peerSeed, "999", new Uint8Array(32).fill(5))],
      ["BAD_KEY", signIdPk(peerSeed, V.peerId, new Uint8Array(33))],
      [
        "BAD_SIGNATURE",
        (() => {
          const s = bytes(V.peerSignedId);
          s[70] = s[70]! ^ 0x80;
          return s;
        })(),
      ],
      ["BAD_SIGNATURE", bytes(V.peerSignedId).slice(0, 40)],
    ];
    for (const [code, signed] of cases) {
      const { relay, p } = run(bytes(V.serverSignedIdPk), [
        messageBytes(signed),
      ]);
      await expectSecureError(p, code);
      assertClosedNothingSent(relay);
    }
  });

  it("first relay frame is not SignedId / not a Message / relay silent / relay closes", async () => {
    const hash = toBinary(
      MessageSchema,
      create(MessageSchema, {
        union: { case: "hash", value: { salt: "s", challenge: "c" } as never },
      }),
    );
    let r = run(bytes(V.serverSignedIdPk), [hash]);
    await expectSecureError(r.p, "PROTOCOL");
    assertClosedNothingSent(r.relay);

    r = run(bytes(V.serverSignedIdPk), [new Uint8Array(0)]); // empty Message
    await expectSecureError(r.p, "PROTOCOL");

    r = run(bytes(V.serverSignedIdPk), [Uint8Array.of(0xff, 0xff, 0xff)]);
    await expectSecureError(r.p, "PROTOCOL");

    r = run(bytes(V.serverSignedIdPk), []); // timeout
    await expectSecureError(r.p, "TIMEOUT");
    assertClosedNothingSent(r.relay);

    const relay = new MockTransport();
    relay.close();
    await expectSecureError(
      secureHandshake(
        relay,
        { pk: bytes(V.serverSignedIdPk) },
        { serverKey, peerId: V.peerId },
      ),
      "CLOSED",
    );
  });

  it("low-order peer box key", () => {
    expect(() => createKeyExchange(new Uint8Array(32))).toThrow(SecureError);
  });
});

describe("fail closed: encrypted channel", () => {
  const key = () => bytes(V.sessionKey);
  const frame = (i: number) => bytes(V.secretbox[i]!.ciphertext);

  it("tampered ciphertext", async () => {
    const f = frame(0).slice();
    f[f.length - 1] = f[f.length - 1]! ^ 1;
    const inner = new MockTransport([f, frame(0)]);
    const t = new SecureTransport(inner, key());
    await expectSecureError(t.recv(), "DECRYPT_FAILED");
    expect(inner.closeInfo?.local).toBe(true);
    // The transport is dead: the valid frame still queued is never delivered.
    await expectSecureError(t.recv(), "DECRYPT_FAILED");
    expect(() => t.send(utf8("x"))).toThrow(SecureError);
    expect(inner.sent.length).toBe(0);
  });

  it("wrong key", async () => {
    const inner = new MockTransport([frame(0)]);
    const t = new SecureTransport(inner, new Uint8Array(32).fill(9));
    await expectSecureError(t.recv(), "DECRYPT_FAILED");
    expect(inner.closeInfo).toBeDefined();
  });

  it("replay of an already-accepted frame", async () => {
    const inner = new MockTransport([frame(0), frame(0)]);
    const t = new SecureTransport(inner, key());
    expect(hex(await t.recv())).toBe(V.secretbox[0]!.plaintext);
    await expectSecureError(t.recv(), "DECRYPT_FAILED");
    expect(inner.closeInfo).toBeDefined();
  });

  it("out-of-order delivery (counter 2 before counter 1)", async () => {
    const inner = new MockTransport([frame(1), frame(0)]);
    const t = new SecureTransport(inner, key());
    await expectSecureError(t.recv(), "DECRYPT_FAILED");
    expect(inner.closeInfo).toBeDefined();
  });

  it("dropped frame (counter 1 never arrives)", async () => {
    const inner = new MockTransport([frame(2)]);
    const t = new SecureTransport(inner, key());
    await expectSecureError(t.recv(), "DECRYPT_FAILED");
  });

  it("plaintext frames are never passed through (empty, 1 byte, short, long)", async () => {
    for (const f of [
      new Uint8Array(0),
      Uint8Array.of(7),
      new Uint8Array(15),
      utf8("this looks like a plain protobuf message....."),
    ]) {
      const inner = new MockTransport([f]);
      const t = new SecureTransport(inner, key());
      const err = await t.recv().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SecureError);
      expect(inner.closeInfo).toBeDefined();
    }
  });

  it("inner timeout / close pass through unchanged and do not mark the channel failed", async () => {
    const inner = new MockTransport([frame(0)]);
    const t = new SecureTransport(inner, key());
    await t.recv();
    await expect(t.recv(5)).rejects.toBeInstanceOf(TransportTimeoutError);
    inner.inbox.push(frame(1));
    expect(hex(await t.recv(5))).toBe(V.secretbox[1]!.plaintext);
    inner.close();
    await expect(t.recv()).rejects.toBeInstanceOf(TransportClosedError);
  });

  it("rejects a session key of the wrong length", () => {
    expect(
      () => new SecureTransport(new MockTransport(), new Uint8Array(31)),
    ).toThrow(SecureError);
  });
});
