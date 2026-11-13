import {
  TransportClosedError,
  TransportTimeoutError,
} from "../transport/types.js";
import type { FrameTransport } from "../transport/types.js";
import { RendezvousError } from "./errors.js";
import {
  buildPunchHoleRequest,
  interpretAnswer,
  parseRendezvousMessage,
} from "./messages.js";
import type { RelayAssignment, RelayRequest } from "./messages.js";

export interface RequestRelayOptions {
  /** Overall deadline for hbbs to answer. Default 15000 ms. */
  timeoutMs?: number;
}

export const DEFAULT_RENDEZVOUS_TIMEOUT_MS = 15_000;

/**
 * Sends the PunchHoleRequest and waits for the answer. Does not close the
 * transport (the reference closes it right after the answer; callers do that).
 *
 * rustdesk-server 1.1.16 closes the idle WS after 30 s; the default 15 s deadline stays under that.
 */
export async function requestRelay(
  transport: FrameTransport,
  req: RelayRequest,
  opts: RequestRelayOptions = {},
): Promise<RelayAssignment> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDEZVOUS_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  try {
    transport.send(buildPunchHoleRequest(req));
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeoutError(timeoutMs);
      const frame = await transport.recv(remaining);
      const answer = interpretAnswer(parseRendezvousMessage(frame));
      if (answer) return answer;
    }
  } catch (e) {
    if (e instanceof RendezvousError) throw e;
    if (e instanceof TransportTimeoutError)
      throw new RendezvousError("TIMEOUT", undefined, undefined, { cause: e });
    if (e instanceof TransportClosedError)
      throw new RendezvousError("CLOSED", undefined, undefined, { cause: e });
    throw e;
  }
}
