// Pure builders / parsers for the hbbs conversation (no socket involved).
//
// Mirrors rustdesk 1.2.5 flutter/web/js/src/connection.ts `_start` / `connectRelay`
// (AGPL-3.0): the browser sets exactly id, nat_type, licence_key, conn_type and
// token on PunchHoleRequest; proto3 omits default values, so conn_type
// (DEFAULT_CONN = 0) and an empty token do not appear on the wire.

import {
  ConnType,
  NatType,
  PunchHoleRequestSchema,
  RendezvousMessageSchema,
  RequestRelaySchema,
} from "../gen/rendezvous_pb.js";
import type { RelayResponse, RendezvousMessage } from "../gen/rendezvous_pb.js";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { failureToError, RendezvousError } from "./errors.js";

export interface RelayRequest {
  /** Peer ID to connect to. */
  peerId: string;
  /** hbbs public key (base64 id_ed25519.pub contents), sent as licence_key. Empty for none. */
  licenceKey: string;
  /** Account access token; omitted from the wire when empty. */
  token?: string;
  /**
   * What the connection is for. Default DEFAULT_CONN (remote desktop); FILE_TRANSFER for a
   * file-transfer session, as the native client sets it.
   */
  connType?: ConnType;
}

export interface RelayAssignment {
  /** Relay address as hbbs forwarded it from the peer (e.g. "rustdesk-relay.example.net"); may be empty. */
  relayServer: string;
  /** Pairing token the browser must present to hbbr in RequestRelay. */
  uuid: string;
  /** Raw bytes of hbbs's signed IdPk (64-byte ed25519 signature + IdPk). NOT verified here. Empty if hbbs sent none. */
  pk: Uint8Array;
  /** Peer software version, e.g. "1.5.3". */
  version: string;
}

export function buildPunchHoleRequest(req: RelayRequest): Uint8Array {
  return toBinary(
    RendezvousMessageSchema,
    create(RendezvousMessageSchema, {
      union: {
        case: "punchHoleRequest",
        value: create(PunchHoleRequestSchema, {
          id: req.peerId,
          natType: NatType.SYMMETRIC,
          licenceKey: req.licenceKey,
          connType: req.connType ?? ConnType.DEFAULT_CONN,
          token: req.token ?? "",
        }),
      },
    }),
  );
}

/** First frame on the hbbr socket (used): RequestRelay{uuid, licence_key}. */
export function buildRequestRelay(
  uuid: string,
  licenceKey: string,
): Uint8Array {
  return toBinary(
    RendezvousMessageSchema,
    create(RendezvousMessageSchema, {
      union: {
        case: "requestRelay",
        value: create(RequestRelaySchema, { uuid, licenceKey }),
      },
    }),
  );
}

export function parseRendezvousMessage(frame: Uint8Array): RendezvousMessage {
  try {
    return fromBinary(RendezvousMessageSchema, frame);
  } catch (e) {
    throw new RendezvousError("PROTOCOL", undefined, undefined, { cause: e });
  }
}

/**
 * Interprets one inbound hbbs message in answer to a PunchHoleRequest.
 * Returns an assignment, throws a RendezvousError for a definitive failure, or
 * returns undefined for a message to ignore.
 *
 * rustdesk-server 1.1.16 (`handle_tcp`, `handle_punch_hole_request`) only ever
 * writes three kinds of message to a WebSocket client in this exchange:
 * PunchHoleResponse with a failure, RelayResponse (forwarded from the peer),
 * and PunchHoleResponse built from a PunchHoleSent (direct-connect offer).
 * Anything else is unexpected and ignored (it cannot be an answer; the
 * overall timeout still bounds the wait).
 */
export function interpretAnswer(
  msg: RendezvousMessage,
): RelayAssignment | undefined {
  const u = msg.union;
  if (u.case === "relayResponse") return assignmentFromRelayResponse(u.value);
  if (u.case === "punchHoleResponse") {
    const r = u.value;
    if (r.otherFailure) throw failureToError(r.failure, r.otherFailure);
    // A genuine failure carries no address and no pk (server sets only `failure`).
    // Failure's default value is ID_NOT_EXIST = 0, so a message with an address
    // is a direct-connect offer, not an "ID does not exist".
    if (r.socketAddr.length > 0 || r.pk.length > 0 || r.relayServer !== "") {
      throw new RendezvousError("DIRECT_ONLY");
    }
    throw failureToError(r.failure);
  }
  return undefined;
}

export function assignmentFromRelayResponse(
  rr: RelayResponse,
): RelayAssignment {
  if (rr.refuseReason) throw new RendezvousError("REFUSED", rr.refuseReason);
  // Same check as the reference client (connection.ts: `if (!rr.version)`).
  if (!rr.version) throw new RendezvousError("PEER_VERSION_TOO_OLD");
  return {
    relayServer: rr.relayServer,
    uuid: rr.uuid,
    pk: rr.union.case === "pk" ? rr.union.value : new Uint8Array(0),
    version: rr.version,
  };
}
