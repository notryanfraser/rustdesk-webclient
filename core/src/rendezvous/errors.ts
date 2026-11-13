import { RustDeskError } from "../errors.js";
import { PunchHoleResponse_Failure } from "../gen/rendezvous_pb.js";

export type RendezvousErrorCode =
  /** hbbs: the peer ID is not registered. */
  | "ID_NOT_EXIST"
  /** hbbs: the peer is registered but has not checked in recently. */
  | "OFFLINE"
  /** hbbs: our licence_key differs from hbbs's -k key. */
  | "LICENSE_MISMATCH"
  | "LICENSE_OVERUSE"
  /** PunchHoleResponse.other_failure (free text in `message`) or an unknown failure enum value. */
  | "OTHER"
  /** RelayResponse.refuse_reason was non-empty (text in `message`). */
  | "REFUSED"
  /** RelayResponse carried no version: the peer predates web support (reference: "Remote version is low"). */
  | "PEER_VERSION_TOO_OLD"
  /** hbbs answered with a non-failure PunchHoleResponse (peer offered a direct address); a browser cannot use it. */
  | "DIRECT_ONLY"
  | "TIMEOUT"
  /** The transport closed before an answer arrived. */
  | "CLOSED"
  /** Undecodable frame. */
  | "PROTOCOL";

export class RendezvousError extends RustDeskError<
  "rendezvous",
  RendezvousErrorCode
> {
  constructor(
    code: RendezvousErrorCode,
    message?: string,
    /** Raw `PunchHoleResponse.Failure` value when the error came from one. */
    readonly failure?: number,
    options?: { cause?: unknown },
  ) {
    super("rendezvous", code, message ?? DEFAULT_MESSAGES[code], options);
    this.name = "RendezvousError";
  }
}

const DEFAULT_MESSAGES: Record<RendezvousErrorCode, string> = {
  ID_NOT_EXIST: "ID does not exist",
  OFFLINE: "Remote desktop is offline",
  LICENSE_MISMATCH: "Key mismatch",
  LICENSE_OVERUSE: "Key overuse",
  OTHER: "Rendezvous server reported a failure",
  REFUSED: "Relay request refused by the peer",
  PEER_VERSION_TOO_OLD: "Remote version is low, not support web",
  DIRECT_ONLY:
    "Server offered only a direct connection, which a browser cannot use",
  TIMEOUT: "Rendezvous server did not answer in time",
  CLOSED: "Rendezvous connection closed before an answer arrived",
  PROTOCOL: "Malformed rendezvous message",
};

/** Maps PunchHoleResponse.failure to an error code (unknown values -> OTHER). */
export function failureToError(
  failure: number,
  otherFailure = "",
): RendezvousError {
  if (otherFailure) return new RendezvousError("OTHER", otherFailure, failure);
  switch (failure) {
    case PunchHoleResponse_Failure.ID_NOT_EXIST:
      return new RendezvousError("ID_NOT_EXIST", undefined, failure);
    case PunchHoleResponse_Failure.OFFLINE:
      return new RendezvousError("OFFLINE", undefined, failure);
    case PunchHoleResponse_Failure.LICENSE_MISMATCH:
      return new RendezvousError("LICENSE_MISMATCH", undefined, failure);
    case PunchHoleResponse_Failure.LICENSE_OVERUSE:
      return new RendezvousError("LICENSE_OVERUSE", undefined, failure);
    default:
      return new RendezvousError(
        "OTHER",
        `Unknown failure ${failure}`,
        failure,
      );
  }
}
