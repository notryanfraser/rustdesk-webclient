// Drives the secure handshake over an hbbr transport. Ported from
// rustdesk 1.2.5 flutter/web/js/src/connection.ts `secure()` 159-234
// rustdesk 1.5.3 src/client.rs secure_connection 1655-1778
// (see ./keyexchange.ts for the per-step citations).

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { MessageSchema, PublicKeySchema } from "../gen/message_pb.js";
import type { RelayAssignment } from "../rendezvous/messages.js";
import {
  TransportClosedError,
  TransportTimeoutError,
} from "../transport/types.js";
import type { FrameTransport } from "../transport/types.js";
import { SecureError } from "./errors.js";
import {
  createKeyExchange,
  defaultRandomBytes,
  verifyPeerSignedId,
  verifyServerSignedIdPk,
} from "./keyexchange.js";
import type { RandomBytes } from "./keyexchange.js";
import { SecureTransport } from "./secure-transport.js";

export interface SecureHandshakeOptions {
  /** hbbs public key, base64 (contents of id_ed25519.pub). Required; there is no default. */
  serverKey: string;
  /** The peer ID that was requested (RelayResponse.pk and SignedId must name it). */
  peerId: string;
  /** Wait for the peer's SignedId at most this long. Default 15000 ms. */
  timeoutMs?: number;
  /** Randomness source (tests only). */
  rand?: RandomBytes;
}

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * `relay` must be an open hbbr transport on which RequestRelay has ALREADY been sent
 * (buildRequestRelay). Verifies hbbs's signed IdPk (before touching the socket), waits for
 * the peer's SignedId, verifies it, sends PublicKey, and returns the encrypted transport.
 * On any failure the relay transport is closed, nothing but RequestRelay has been sent,
 * and a SecureError is thrown; there is no unencrypted fallback.
 */
export async function secureHandshake(
  relay: FrameTransport,
  assignment: Pick<RelayAssignment, "pk">,
  opts: SecureHandshakeOptions,
): Promise<SecureTransport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  try {
    // connection.ts:163-176 / client.rs:1679-1685
    const { peerSignPk } = verifyServerSignedIdPk(
      assignment.pk,
      opts.serverKey,
      opts.peerId,
    );

    // connection.ts:188 `await this._ws.next()` / client.rs:1702
    const frame = await relay.recv(timeoutMs);
    let msg;
    try {
      msg = fromBinary(MessageSchema, frame);
    } catch (e) {
      throw new SecureError("PROTOCOL", "first relay frame is not a Message", {
        cause: e,
      });
    }
    if (msg.union.case !== "signedId")
      throw new SecureError(
        "PROTOCOL",
        `expected SignedId, got ${msg.union.case ?? "empty message"}`,
      );

    // connection.ts:196-222 / client.rs:1707-1710
    const { peerBoxPk } = verifyPeerSignedId(
      msg.union.value.id,
      peerSignPk,
      opts.peerId,
    );

    // connection.ts:223-231 / client.rs:1723-1739
    const kx = createKeyExchange(peerBoxPk, opts.rand ?? defaultRandomBytes);
    relay.send(
      toBinary(
        MessageSchema,
        create(MessageSchema, {
          union: {
            case: "publicKey",
            value: create(PublicKeySchema, {
              asymmetricValue: kx.asymmetricValue,
              symmetricValue: kx.symmetricValue,
            }),
          },
        }),
      ),
    );
    return new SecureTransport(relay, kx.sessionKey);
  } catch (e) {
    relay.close(1008, "secure handshake failed");
    if (e instanceof SecureError) throw e;
    if (e instanceof TransportTimeoutError)
      throw new SecureError("TIMEOUT", "peer did not send SignedId in time", {
        cause: e,
      });
    if (e instanceof TransportClosedError)
      throw new SecureError("CLOSED", "relay closed during handshake", {
        cause: e,
      });
    throw e;
  }
}
