// Error taxonomy umbrella. Every error this library throws on purpose is a RustDeskError
// carrying a `layer` (which part of the stack failed) and a `code` (what failed, within that
// layer). `layer` + `code` is the stable identity; codes are unique only within a layer
// (e.g. "TIMEOUT" exists in rendezvous, secure and session). `describeError` turns any
// thrown value into a UI-ready description.

export type ErrorLayer =
  /** Bad configuration supplied by the caller (server address). */
  | "config"
  /** WebSocket open / frame transport. */
  | "transport"
  /** hbbs conversation (ID resolution, relay assignment). */
  | "rendezvous"
  /** Key exchange and the encrypted channel. */
  | "secure"
  /** Login and the logged-in session. */
  | "session";

/** Base class of every typed error in the library. */
export class RustDeskError<
  L extends ErrorLayer = ErrorLayer,
  C extends string = string,
> extends Error {
  constructor(
    readonly layer: L,
    readonly code: C,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? code, options);
    this.name = "RustDeskError";
  }
}

export type TransportErrorCode =
  /** The socket closed (see TransportClosedError.info). */
  | "CLOSED"
  /** No frame within the deadline (TransportTimeoutError). */
  | "TIMEOUT"
  /** The WebSocket could not be opened (refused, DNS, TLS, proxy). */
  | "CONNECT_FAILED"
  /** The WebSocket did not open within the connect deadline. */
  | "CONNECT_TIMEOUT";

export class TransportError extends RustDeskError<
  "transport",
  TransportErrorCode
> {
  constructor(
    code: TransportErrorCode,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super("transport", code, message, options);
    this.name = "TransportError";
  }
}

export type ConfigErrorCode =
  /** idServerUrl / relayUrl got something that is not "host" or "host:port". */
  "BAD_SERVER_ADDRESS";

export class ConfigError extends RustDeskError<"config", ConfigErrorCode> {
  constructor(
    code: ConfigErrorCode,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super("config", code, message, options);
    this.name = "ConfigError";
  }
}
