// Contract between the transport layer and the protocol layers above it
// (rendezvous, secure channel, session).
//
// One RustDesk protocol message per binary WebSocket frame, no length prefix;
// text frames are ignored. The
// transport moves opaque frames only: no protobuf, no crypto.

import { TransportError } from "../errors.js";

export interface CloseInfo {
  code: number;
  reason: string;
  /** True when this side called close(). */
  local: boolean;
}

export interface FrameTransport {
  /** Queue one binary frame. Throws TransportClosedError once closed. */
  send(frame: Uint8Array): void;

  /**
   * Resolve with the next inbound binary frame, in arrival order. Rejects with
   * TransportTimeoutError after `timeoutMs` (if given) and with
   * TransportClosedError once the socket is closed and no frames remain.
   */
  recv(timeoutMs?: number): Promise<Uint8Array>;

  /** Close the socket. Idempotent. */
  close(code?: number, reason?: string): void;

  /** Resolves once, when the socket has closed for any reason. */
  readonly closed: Promise<CloseInfo>;

  /**
   * Optional backpressure: resolves when the socket's send buffer is back under its high-water
   * mark (WsTransport: 4 MiB). Bulk senders (file upload) await it between frames.
   */
  drained?(): Promise<void>;
}

/** Opens a connected transport, e.g. `wss://rustdesk-id.example.net:443`. */
export type ConnectFn = (
  url: string,
  opts?: { timeoutMs?: number },
) => Promise<FrameTransport>;

export class TransportClosedError extends TransportError {
  constructor(readonly info: CloseInfo) {
    super(
      "CLOSED",
      `transport closed (${info.code}${info.reason ? `: ${info.reason}` : ""})`,
    );
    this.name = "TransportClosedError";
  }
}

export class TransportTimeoutError extends TransportError {
  constructor(readonly timeoutMs: number) {
    super("TIMEOUT", `no frame within ${timeoutMs} ms`);
    this.name = "TransportTimeoutError";
  }
}
