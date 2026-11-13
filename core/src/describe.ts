// describeError: one uniform description of every failure the library can raise, so a UI can
// show a plain-English message and decide whether offering "Try again" makes sense without
// knowing which layer failed. The catalog below is typed per layer, so a new code cannot be added
// without a message.

import type {
  ConfigErrorCode,
  ErrorLayer,
  TransportErrorCode,
} from "./errors.js";
import { RustDeskError } from "./errors.js";
import type { RendezvousErrorCode } from "./rendezvous/errors.js";
import type { SecureErrorCode } from "./crypto/errors.js";
import type { SessionClosed } from "./session/session.js";
import type { SessionErrorCode } from "./session/errors.js";

export interface ErrorDescription {
  /** "unknown" when the value is not a RustDeskError. */
  layer: ErrorLayer | "unknown";
  /** Stable code within the layer ("UNKNOWN" for a foreign error). */
  code: string;
  /** Plain English for a person, with what to do about it. Never contains secrets. */
  userMessage: string;
  /**
   * True when trying again with the SAME settings and input can plausibly succeed (possibly after
   * a short wait). False when the person must change something first (key, ID, password,
   * server address) or the peer/server cannot do what was asked.
   */
  retryable: boolean;
  /** Technical text for logs or a "details" disclosure (the error's message / peer's own words). */
  detail: string;
}

interface Entry {
  userMessage: string;
  retryable: boolean;
}

const e = (userMessage: string, retryable: boolean): Entry => ({
  userMessage,
  retryable,
});

type Catalog = {
  config: Record<ConfigErrorCode, Entry>;
  transport: Record<TransportErrorCode, Entry>;
  rendezvous: Record<RendezvousErrorCode, Entry>;
  secure: Record<SecureErrorCode, Entry>;
  session: Record<SessionErrorCode, Entry>;
};

export const ERROR_CATALOG: Catalog = {
  config: {
    BAD_SERVER_ADDRESS: e(
      "The server address in settings isn't valid. Use just a host name, or host:port, and try again.",
      false,
    ),
  },
  transport: {
    CLOSED: e(
      "The connection dropped unexpectedly. Check your network and try again.",
      true,
    ),
    TIMEOUT: e("The server stopped responding. Try again in a moment.", true),
    CONNECT_FAILED: e(
      "Couldn't reach the server. Check the server address in settings and your network, then try again.",
      true,
    ),
    CONNECT_TIMEOUT: e(
      "Timed out connecting to the server. Check the server address in settings and your network, then try again.",
      true,
    ),
  },
  rendezvous: {
    ID_NOT_EXIST: e(
      "That ID isn't registered with your server. Check the ID, and that the remote computer is set to use your server.",
      false,
    ),
    OFFLINE: e(
      "The remote computer is offline. Make sure it is on, online and running RustDesk, then try again.",
      true,
    ),
    LICENSE_MISMATCH: e(
      "Server key mismatch. Check the key in settings.",
      false,
    ),
    LICENSE_OVERUSE: e(
      "The server rejected the connection because its license limit was exceeded. Ask the server's administrator.",
      false,
    ),
    OTHER: e(
      "The server refused the request. See the details, or ask the server's administrator.",
      false,
    ),
    REFUSED: e(
      "The remote computer refused the connection. See the details for its reason.",
      false,
    ),
    PEER_VERSION_TOO_OLD: e(
      "The remote computer's RustDesk is too old to accept web connections. Update RustDesk there.",
      false,
    ),
    DIRECT_ONLY: e(
      "The server offered only a direct connection, which a browser can't use. Connect with a desktop RustDesk client instead.",
      false,
    ),
    TIMEOUT: e(
      "The server didn't answer in time. Try again in a moment.",
      true,
    ),
    CLOSED: e(
      "The server closed the connection before answering. Try again.",
      true,
    ),
    PROTOCOL: e(
      "The server sent something unexpected. Try again, and check the server address and version if it keeps happening.",
      true,
    ),
  },
  secure: {
    NO_SERVER_KEY: e(
      "No server key is set. Enter your server's public key in settings.",
      false,
    ),
    BAD_SERVER_KEY: e(
      "The server key in settings isn't valid. Copy it again from the server's id_ed25519.pub file.",
      false,
    ),
    NO_SERVER_PK: e(
      "The server didn't vouch for the remote computer, so the connection was refused for safety. Check the server key in settings and that the server is set up with a key.",
      false,
    ),
    BAD_SIGNATURE: e("Server key mismatch. Check the key in settings.", false),
    ID_MISMATCH: e(
      "The remote computer identified itself with a different ID, so the connection was refused for safety. Check the ID and try again.",
      false,
    ),
    BAD_KEY: e(
      "The remote computer sent an invalid encryption key, so the connection was refused for safety.",
      false,
    ),
    PROTOCOL: e(
      "The remote computer sent something unexpected during the secure handshake. Try again.",
      true,
    ),
    CLOSED: e(
      "The connection closed while setting up encryption. Try again.",
      true,
    ),
    TIMEOUT: e(
      "The remote computer didn't answer the secure handshake in time. Check that it's on and try again.",
      true,
    ),
    DECRYPT_FAILED: e(
      "Data failed its integrity check, so the session was ended for safety. Reconnect.",
      true,
    ),
    BAD_FRAME: e(
      "A damaged message was received, so the session was ended for safety. Reconnect.",
      true,
    ),
    COUNTER_EXHAUSTED: e(
      "The session ran too long to stay secure. Reconnect.",
      true,
    ),
    FAILED: e(
      "The secure connection already failed. Start a new connection.",
      true,
    ),
  },
  session: {
    INVALID_ARGUMENT: e("Enter the remote ID and the password.", false),
    WRONG_PASSWORD: e(
      "Wrong password. Check it and try again. Repeated wrong passwords lock you out for a minute.",
      false,
    ),
    PASSWORD_REQUIRED: e("Enter the remote computer's password.", false),
    NO_PASSWORD_ACCESS: e(
      "The remote computer only lets people in when someone clicks Accept on its screen, and nobody did. Ask them to accept, then try again.",
      true,
    ),
    TWO_FACTOR_REQUIRED: e(
      "The remote computer needs a two-factor code, which the web client doesn't support yet.",
      false,
    ),
    WRONG_TWO_FACTOR: e(
      "The two-factor code was wrong, and the web client doesn't support two-factor yet.",
      false,
    ),
    TOO_MANY_ATTEMPTS: e(
      "Locked out for a minute after too many wrong attempts. Wait a minute, then try again.",
      true,
    ),
    OFFLINE: e(
      "The remote computer says that ID isn't its own. Check the ID.",
      false,
    ),
    BLOCKED: e(
      "The remote computer has blocked this device or this ID. Ask its owner to unblock it.",
      false,
    ),
    NOT_ALLOWED: e(
      "The remote computer doesn't allow this connection. Ask its owner to change its permissions.",
      false,
    ),
    PRIVACY_MODE: e(
      "Someone turned on privacy mode on the remote computer. Try again later.",
      true,
    ),
    NO_SCREEN: e(
      "The remote computer can't share its screen right now (for example at a Wayland login screen, or with no desktop session). Log in there, or try again later.",
      true,
    ),
    PEER_ERROR: e(
      "The remote computer rejected the login. See the details for its message.",
      false,
    ),
    PEER_CLOSED: e(
      "The remote computer ended the connection. See the details for its reason.",
      true,
    ),
    TIMEOUT: e(
      "The remote computer stopped responding. Check that it's on and try again.",
      true,
    ),
    CLOSED: e(
      "The connection to the remote computer dropped. Try again.",
      true,
    ),
    PROTOCOL: e(
      "The remote computer sent something unexpected. Try again.",
      true,
    ),
    SESSION_CLOSED: e("The session has ended. Connect again.", false),
    NO_DISPLAY: e(
      "The remote computer has no screen to show. Turn on a display or log in there, then try again.",
      true,
    ),
  },
};

const UNKNOWN: Entry = e(
  "Something went wrong. Try again, and check the details if it keeps happening.",
  false,
);

/** Describe any thrown value. Never throws. */
export function describeError(err: unknown): ErrorDescription {
  if (err instanceof RustDeskError) {
    const layer = err.layer as ErrorLayer;
    const table = ERROR_CATALOG[layer] as Record<string, Entry | undefined>;
    const entry = table[err.code] ?? UNKNOWN;
    const peer = (err as { peerMessage?: string }).peerMessage;
    return {
      layer,
      code: err.code as string,
      userMessage: entry.userMessage,
      retryable: entry.retryable,
      detail:
        peer !== undefined ? `${err.message} [peer: ${peer}]` : err.message,
    };
  }
  return {
    layer: "unknown",
    code: "UNKNOWN",
    userMessage: UNKNOWN.userMessage,
    retryable: UNKNOWN.retryable,
    detail: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Describe why a Session ended, or `undefined` when we ended it ourselves (kind "local").
 * Maps onto session-layer codes: peer -> PEER_CLOSED, transport -> CLOSED, timeout -> TIMEOUT,
 * error -> PROTOCOL.
 */
export function describeSessionClosed(
  closed: SessionClosed,
): ErrorDescription | undefined {
  const code: SessionErrorCode | undefined = {
    local: undefined,
    peer: "PEER_CLOSED",
    transport: "CLOSED",
    timeout: "TIMEOUT",
    error: "PROTOCOL",
  }[closed.kind] as SessionErrorCode | undefined;
  if (code === undefined) return undefined;
  const entry = ERROR_CATALOG.session[code];
  return {
    layer: "session",
    code,
    userMessage: entry.userMessage,
    retryable: entry.retryable,
    detail: closed.message,
  };
}
