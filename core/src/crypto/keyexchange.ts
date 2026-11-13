// Pure (socket-free) steps of the RustDesk secure-channel handshake, ported from
// rustdesk 1.2.5 flutter/web/js/src/connection.ts `secure()` (AGPL-3.0)
// rustdesk 1.2.5 flutter/web/js/src/globals.js verify / genBoxKeyPair / genSecretKey / seal
// and cross-checked against what a 1.5.3 peer expects:
// rustdesk 1.5.3 src/client.rs secure_connection (controller side, 1655-1778)
// rustdesk 1.5.3 src/common.rs decode_id_pk_dtls (2428-2440), create_symmetric_key_msg (2449-2456)
// rustdesk 1.5.3 src/server.rs identity_handshake (peer side, 263-346)
// hbb_common fae47e0 src/tcp.rs Encrypt::decode (peer side opens the key, 404-424)
//
// Deviation from upstream (intentional, stricter): every failure throws SecureError.
// Upstream falls back to an unencrypted session (an empty PublicKey / Message) on a
// bad key, bad signature, ID mismatch, wrong pk length or wrong message type
// (connection.ts:177-221; client.rs:1686-1700, 1750-1776). We never do.
//
// NOTE there is NO ed25519 -> curve25519 conversion anywhere upstream (grep of 1.2.5 JS and
// 1.5.3 src/ + hbb_common for "curve25519" finds nothing). Two different keys are involved:
// * ed25519 signing keys (hbbs's, and the peer's long-term id key), used only to sign/verify;
// * a fresh X25519 *box* keypair the peer generates per connection (server.rs:271
// `box_::gen_keypair()`), whose public half is what the peer signs inside IdPk.pk.

import nacl from "tweetnacl";
import { fromBinary } from "@bufbuild/protobuf";
import { IdPkSchema } from "../gen/rendezvous_pb.js";
import { SecureError } from "./errors.js";

export const ED25519_PK_BYTES = 32;
export const BOX_PK_BYTES = 32;
export const SESSION_KEY_BYTES = 32;

/** Source of randomness: returns `n` random bytes. Inject a fixed one in tests. */
export type RandomBytes = (n: number) => Uint8Array;

export const defaultRandomBytes: RandomBytes = (n) =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

const STD_B64_32 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Decodes the hbbs public key (contents of id_ed25519.pub, standard base64 with padding —
 * libsodium base64_variants.ORIGINAL, globals.js:147-149; native `crate::decode64`).
 * Upstream replaces an empty key with the public RustDesk key
 * `OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=` (connection.ts:161, config.rs:117
 * RS_PUB_KEY); we throw instead, so a missing key can never silently authenticate
 * against the wrong root.
 */
export function decodeServerKey(serverKeyB64: string): Uint8Array {
  const k = serverKeyB64.trim();
  if (k === "")
    throw new SecureError("NO_SERVER_KEY", "no hbbs public key configured");
  if (!STD_B64_32.test(k))
    throw new SecureError(
      "BAD_SERVER_KEY",
      "hbbs key is not base64 of 32 bytes",
    );
  const bin = atob(k);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function openSigned(signed: Uint8Array, pk: Uint8Array, what: string) {
  // crypto_sign_open, combined mode: 64-byte signature || message (globals.js:144;
  // sodiumoxide sign::verify, common.rs:2433). tweetnacl's nacl.sign.open is the same format.
  if (signed.length < nacl.sign.signatureLength)
    throw new SecureError("BAD_SIGNATURE", `${what}: shorter than a signature`);
  const msg = nacl.sign.open(signed, pk);
  if (msg === null)
    throw new SecureError("BAD_SIGNATURE", `${what}: signature mismatch`);
  return msg;
}

function decodeIdPk(msg: Uint8Array, what: string) {
  try {
    return fromBinary(IdPkSchema, msg);
  } catch (e) {
    throw new SecureError("PROTOCOL", `${what}: malformed IdPk`, { cause: e });
  }
}

/**
 * Step 1: authenticate hbbs's `RelayResponse.pk`. It is sign(IdPk{id, pk}) by the hbbs
 * ed25519 key, where `pk` is the PEER's ed25519 public key as registered with hbbs.
 * 1.2.5: connection.ts:163-176 (verify; require idpk.id == requested id; require 32-byte pk)
 * 1.5.3: client.rs:1679-1685 + common.rs:2428-2440 (same checks)
 */
export function verifyServerSignedIdPk(
  pk: Uint8Array,
  serverKeyB64: string,
  expectedId: string,
): { peerSignPk: Uint8Array } {
  const serverKey = decodeServerKey(serverKeyB64);
  if (pk.length === 0)
    throw new SecureError("NO_SERVER_PK", "hbbs sent no signed IdPk");
  const idpk = decodeIdPk(
    openSigned(pk, serverKey, "RelayResponse.pk"),
    "RelayResponse.pk",
  );
  if (idpk.id !== expectedId)
    throw new SecureError(
      "ID_MISMATCH",
      `RelayResponse.pk is for ${JSON.stringify(idpk.id)}, expected ${JSON.stringify(expectedId)}`,
    );
  if (idpk.pk.length !== ED25519_PK_BYTES)
    throw new SecureError(
      "BAD_KEY",
      `peer signing key is ${idpk.pk.length} bytes, expected 32`,
    );
  return { peerSignPk: idpk.pk };
}

/**
 * Step 2: authenticate the peer's first relay frame, `Message.signed_id.id` =
 * sign(IdPk{id, pk, kx_version?}) by the peer's ed25519 key (the one from step 1).
 * `pk` here is the peer's per-connection X25519 box public key; `kx_version` is the newest
 * key-exchange version the peer speaks (1.5.3 peers advertise 1; absent from 1.2.5 peers).
 * 1.2.5: connection.ts:196-222 1.5.3: client.rs:1707-1710 (+ server.rs:289-300 producer)
 */
export function verifyPeerSignedId(
  signedId: Uint8Array,
  peerSignPk: Uint8Array,
  expectedId: string,
): { peerBoxPk: Uint8Array; peerKxVersion: number } {
  if (peerSignPk.length !== ED25519_PK_BYTES)
    throw new SecureError("BAD_KEY", "peer signing key must be 32 bytes");
  const idpk = decodeIdPk(
    openSigned(signedId, peerSignPk, "SignedId"),
    "SignedId",
  );
  if (idpk.id !== expectedId)
    throw new SecureError(
      "ID_MISMATCH",
      `SignedId is for ${JSON.stringify(idpk.id)}, expected ${JSON.stringify(expectedId)}`,
    );
  if (idpk.pk.length !== BOX_PK_BYTES)
    throw new SecureError(
      "BAD_KEY",
      `peer box key is ${idpk.pk.length} bytes, expected 32`,
    );
  return { peerBoxPk: idpk.pk, peerKxVersion: idpk.kxVersion };
}

export interface SessionKeyExchange {
  /** PublicKey.asymmetric_value: our ephemeral X25519 public key (32 bytes). */
  asymmetricValue: Uint8Array;
  /** PublicKey.symmetric_value: crypto_box(sessionKey) = 16-byte MAC + 32 bytes = 48 bytes. */
  symmetricValue: Uint8Array;
  /** The secretbox key for the session (both directions, original scheme). */
  sessionKey: Uint8Array;
}

/**
 * Step 3: ephemeral box keypair + random session key, session key sealed to the peer's box
 * key with an all-zero 24-byte nonce (safe because the sender key is fresh per connection).
 * 1.2.5: globals.js:151-165 (genBoxKeyPair, genSecretKey, seal = crypto_box_easy, zero nonce)
 * 1.5.3: common.rs:2449-2456 create_symmetric_key_msg (box_::seal, zero nonce)
 * Randomness draws, in order: 32 bytes for the box secret key, 32 bytes for the session key.
 * We send no `kx_version` (original scheme) even though 1.5.3 peers advertise 1: the peer
 * then runs `set_key` (stream.rs set_negotiated_key picked == 0), as the 2026-11-12 capture
 * shows working.
 */
export function createKeyExchange(
  peerBoxPk: Uint8Array,
  rand: RandomBytes = defaultRandomBytes,
): SessionKeyExchange {
  if (peerBoxPk.length !== BOX_PK_BYTES)
    throw new SecureError("BAD_KEY", "peer box key must be 32 bytes");
  const mySk = rand(nacl.box.secretKeyLength);
  const sessionKey = rand(SESSION_KEY_BYTES);
  if (mySk.length !== 32 || sessionKey.length !== 32)
    throw new Error("rand returned the wrong number of bytes");
  // libsodium's crypto_box_easy fails on an all-zero shared secret (low-order peer point);
  // tweetnacl's nacl.box does not, so check explicitly.
  if (nacl.scalarMult(mySk, peerBoxPk).every((b) => b === 0))
    throw new SecureError("BAD_KEY", "peer box key is a low-order point");
  const asymmetricValue = nacl.box.keyPair.fromSecretKey(mySk).publicKey;
  const symmetricValue = nacl.box(
    sessionKey,
    new Uint8Array(nacl.box.nonceLength),
    peerBoxPk,
    mySk,
  );
  return { asymmetricValue, symmetricValue, sessionKey };
}
