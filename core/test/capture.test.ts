// Our client (core, live-session.mjs, 2026-11-12) against the 1.2.5 web client (browser, same
// day): the plaintext part of the handshake must have the same framing. Values that are random
// per connection (uuid, ephemeral key, sealed session key) differ; the field layout must not.
import browserRaw from "../fixtures/decoded/2026-11-12-browser-to-peer.json?raw";
import coreRaw from "../fixtures/decoded/2026-11-12-core-client-login-session.json?raw";
import { describe, expect, it } from "vitest";
import {
  buildLoginRequest,
  buildPunchHoleRequest,
  buildRequestRelay,
} from "../src/index.js";
import { encodeMessage } from "../src/session/codec.js";

interface Frame {
  seq: number;
  stream: "id" | "relay";
  direction: "browser->server" | "server->browser";
  len: number;
  hex: string;
  decoded: Record<string, Record<string, unknown>> | null;
  note?: string;
}
const browser: Frame[] = JSON.parse(browserRaw);
const core: Frame[] = JSON.parse(coreRaw);
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const KEY = "oV+rkiX2RtCRC4sY/ykOr/53kY8l6GfX4HtJpaxkBGk=";

/** [fieldNumber, wireType, length] of every top-level field (length = payload bytes for LEN, else 0). */
function shape(b: Uint8Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  let i = 0;
  const varint = () => {
    let v = 0;
    let s = 0;
    for (;;) {
      const x = b[i++]!;
      v += (x & 0x7f) * 2 ** s;
      s += 7;
      if (!(x & 0x80)) return v;
    }
  };
  while (i < b.length) {
    const tag = varint();
    const wt = tag & 7;
    if (wt === 0) {
      varint();
      out.push([tag >> 3, wt, 0]);
    } else if (wt === 2) {
      const n = varint();
      i += n;
      out.push([tag >> 3, wt, n]);
    } else throw new Error(`wire type ${wt} not handled`);
  }
  return out;
}
/** Shape of the message nested in the single LEN field of an envelope. */
function innerShape(b: Uint8Array) {
  const [[, , n]] = shape(b) as [[number, number, number]];
  return { outer: shape(b), inner: shape(b.slice(b.length - n)) };
}

const pick = (
  fs: Frame[],
  stream: Frame["stream"],
  dir: Frame["direction"],
  nth = 0,
) => fs.filter((f) => f.stream === stream && f.direction === dir)[nth]!;

describe("our client's captured traffic vs the 1.2.5 web client's", () => {
  it("the fixture really is the core client talking to a 1.5.3 peer", () => {
    expect(core.length).toBeGreaterThan(80);
    const pr = core[0]!.decoded!.punchHoleRequest!;
    expect(pr.id).toBe("197903715");
    expect(browser[0]!.decoded!.punchHoleRequest!.id).toBe("496345301");
    expect(
      core.find((f) => f.decoded?.relayResponse)!.decoded!.relayResponse!
        .version,
    ).toBe("1.5.3");
  });

  it("same message sequence and sizes up to the encrypted part", () => {
    const sig = (fs: Frame[]) =>
      fs
        .slice(0, 5) // id: request, response; relay: RequestRelay, SignedId, PublicKey
        .map((f) => `${f.stream} ${f.direction} ${f.len}`);
    expect(sig(core)).toEqual(sig(browser));
    expect(sig(core)).toEqual([
      "id browser->server 61",
      "id server->browser 188",
      "relay browser->server 87",
      "relay server->browser 115",
      "relay browser->server 86",
    ]);
    // the peer's first encrypted frame (Hash, 44 bytes + 16 MAC) is the same size too
    expect(pick(core, "relay", "server->browser", 1).len).toBe(60);
    expect(pick(browser, "relay", "server->browser", 1).len).toBe(60);
  });

  it("PunchHoleRequest: identical fields (id, nat_type, licence_key) and identical wire layout", () => {
    const ours = pick(core, "id", "browser->server");
    const theirs = pick(browser, "id", "browser->server");
    expect(Object.keys(ours.decoded!.punchHoleRequest!).sort()).toEqual([
      "id",
      "licenceKey",
      "natType",
    ]);
    expect(Object.keys(ours.decoded!.punchHoleRequest!)).toEqual(
      Object.keys(theirs.decoded!.punchHoleRequest!),
    );
    expect(ours.decoded!.punchHoleRequest!.natType).toBe("SYMMETRIC");
    expect(innerShape(bytes(ours.hex))).toEqual(innerShape(bytes(theirs.hex)));
    // only the peer ID differs, and byte for byte otherwise
    const swapped = theirs.hex.replace(
      hex(new TextEncoder().encode("496345301")),
      hex(new TextEncoder().encode("197903715")),
    );
    expect(ours.hex).toBe(swapped);
    // and what we build today is exactly what we sent
    expect(
      hex(buildPunchHoleRequest({ peerId: "197903715", licenceKey: KEY })),
    ).toBe(ours.hex);
  });

  it("RequestRelay: same two fields, same layout; uuid differs", () => {
    const ours = pick(core, "relay", "browser->server", 0);
    const theirs = pick(browser, "relay", "browser->server", 0);
    expect(Object.keys(ours.decoded!.requestRelay!)).toEqual([
      "uuid",
      "licenceKey",
    ]);
    expect(Object.keys(ours.decoded!.requestRelay!)).toEqual(
      Object.keys(theirs.decoded!.requestRelay!),
    );
    expect(ours.decoded!.requestRelay!.licenceKey).toBe(
      theirs.decoded!.requestRelay!.licenceKey,
    );
    expect(ours.decoded!.requestRelay!.uuid).not.toBe(
      theirs.decoded!.requestRelay!.uuid,
    );
    expect(innerShape(bytes(ours.hex))).toEqual(innerShape(bytes(theirs.hex)));
    expect(
      hex(buildRequestRelay(ours.decoded!.requestRelay!.uuid as string, KEY)),
    ).toBe(ours.hex);
  });

  it("PublicKey: asymmetric_value 32 B + symmetric_value 48 B, no kx_version; values differ", () => {
    const ours = pick(core, "relay", "browser->server", 1);
    const theirs = pick(browser, "relay", "browser->server", 1);
    const o = innerShape(bytes(ours.hex));
    expect(o).toEqual(innerShape(bytes(theirs.hex)));
    expect(o.inner).toEqual([
      [1, 2, 32],
      [2, 2, 48],
    ]);
    expect(Object.keys(ours.decoded!.publicKey!)).toEqual([
      "asymmetricValue",
      "symmetricValue",
    ]);
    expect(ours.decoded!.publicKey!.asymmetricValue).not.toBe(
      theirs.decoded!.publicKey!.asymmetricValue,
    );
  });

  it("hbbs's RelayResponse and the peer's SignedId have the same layout in both captures", () => {
    const rr = (fs: Frame[]) => bytes(pick(fs, "id", "server->browser").hex);
    expect(innerShape(rr(core)).inner.map(([n, w]) => [n, w])).toEqual(
      innerShape(rr(browser)).inner.map(([n, w]) => [n, w]),
    );
    const sid = (fs: Frame[]) =>
      bytes(pick(fs, "relay", "server->browser", 0).hex);
    expect(innerShape(sid(core))).toEqual(innerShape(sid(browser)));
  });

  it("everything after PublicKey is ciphertext, sized for a MAC, with per-direction counters", () => {
    const enc = core.filter((f) => f.stream === "relay").slice(3);
    expect(enc.length).toBeGreaterThan(80);
    for (const f of enc) {
      expect(f.decoded).toBeNull();
      expect(f.len).toBeGreaterThanOrEqual(17);
      expect(f.note).toMatch(
        /^secretbox ciphertext: counter \d+ in this direction/,
      );
    }
    // our first encrypted frame (counter 1, client->server) is the LoginRequest
    const first = enc.find((f) => f.direction === "browser->server")!;
    expect(first.note).toContain("counter 1 ");
    const lr = buildLoginRequest({
      peerId: "197903715",
      password: "any password",
      hash: { salt: "x", challenge: "y" },
    });
    // 16-byte MAC + the LoginRequest we build (the password field is a fixed 32-byte digest)
    expect(first.len).toBe(16 + encodeMessage(lr).length);
  });
});
