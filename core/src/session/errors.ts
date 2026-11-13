import { RustDeskError } from "../errors.js";

export type SessionErrorCode =
  /** Caller error: empty password or peer ID (nothing was sent). */
  | "INVALID_ARGUMENT"
  /** LoginResponse.error "Wrong Password". */
  | "WRONG_PASSWORD"
  /** LoginResponse.error "Empty Password" (a client-side constant upstream; 1.5.3 peers do not send it). */
  | "PASSWORD_REQUIRED"
  /**
   * "No Password Access": the peer only admits sessions someone accepts on the remote screen.
   * NOT terminal: login() keeps waiting and reports it via `onWaitingForApproval`; this error is
   * thrown only if nobody approved within `approvalTimeoutMs` (see login.ts).
   */
  | "NO_PASSWORD_ACCESS"
  /** "2FA Required" / "Wrong 2FA Code": the peer wants a TOTP code; not supported yet. */
  | "TWO_FACTOR_REQUIRED"
  | "WRONG_TWO_FACTOR"
  /** "Too many wrong attempts[ for IPv6 prefix /N]" / "Please try 1 minute later": the peer's brute-force limiter. */
  | "TOO_MANY_ATTEMPTS"
  /** "Offline": the peer says the ID in LoginRequest.username is not its own. */
  | "OFFLINE"
  /** "Your ip is blocked by the peer" / "Your ID is blocked by the peer". */
  | "BLOCKED"
  /** "Connection not allowed", "No permission of ...", "Supported only in the installed version.". */
  | "NOT_ALLOWED"
  /** "Someone turns on privacy mode, exit". */
  | "PRIVACY_MODE"
  /** The peer cannot capture a screen: Wayland login screen, unsupported display server, no desktop session. */
  | "NO_SCREEN"
  /** Any other LoginResponse.error string (verbatim in `peerMessage`). */
  | "PEER_ERROR"
  /** The peer sent Misc.close_reason (text in `peerMessage`) before the login finished. */
  | "PEER_CLOSED"
  /** No LoginResponse within the login timeout. */
  | "TIMEOUT"
  /** The transport closed before the login finished. */
  | "CLOSED"
  /** Undecodable message, or the secure channel failed (cause is the SecureError). */
  | "PROTOCOL"
  /** send() on a Session that is closed. */
  | "SESSION_CLOSED"
  /**
   * Login succeeded but peer_info.displays is empty (the peer has nothing to capture). Never
   * thrown by default: login() reports it as `noDisplay: true`; connectSession throws it only
   * with `requireDisplay: true`. Reference: rustdesk 1.5.3 src/ui_session_interface.rs
   * handle_peer_info 1831-1840 ("No displays" msgbox, no disconnect); 1.2.5 connection.ts
   * handlePeerInfo 568-572 ("No Display").
   */
  | "NO_DISPLAY";

export class SessionError extends RustDeskError<"session", SessionErrorCode> {
  constructor(
    code: SessionErrorCode,
    message?: string,
    /** The peer's verbatim error text, when the error came from a LoginResponse / close_reason. */
    readonly peerMessage?: string,
    options?: { cause?: unknown },
  ) {
    super("session", code, message ?? DEFAULT_MESSAGES[code], options);
    this.name = "SessionError";
  }
}

const DEFAULT_MESSAGES: Record<SessionErrorCode, string> = {
  INVALID_ARGUMENT: "invalid argument",
  WRONG_PASSWORD: "Wrong Password",
  PASSWORD_REQUIRED: "Empty Password",
  NO_PASSWORD_ACCESS:
    "The peer requires the session to be accepted on the remote side, and nobody accepted it",
  TWO_FACTOR_REQUIRED: "The peer requires a 2FA code (not supported)",
  WRONG_TWO_FACTOR: "Wrong 2FA Code",
  TOO_MANY_ATTEMPTS: "The peer is rate-limiting login attempts",
  OFFLINE: "The peer reports itself offline for this ID",
  BLOCKED: "The peer blocked this client",
  NOT_ALLOWED: "The peer does not allow this connection",
  PRIVACY_MODE: "The peer is in privacy mode",
  NO_SCREEN: "The peer cannot provide a screen",
  PEER_ERROR: "The peer rejected the login",
  PEER_CLOSED: "The peer closed the connection",
  TIMEOUT: "The peer did not answer the login in time",
  CLOSED: "Connection closed before the login finished",
  PROTOCOL: "Malformed or unexpected message from the peer",
  SESSION_CLOSED: "The session is closed",
  NO_DISPLAY: "The peer reported no displays",
};

// Peer error strings.
// rustdesk 1.5.3 src/client.rs:117-123 (LOGIN_MSG_*, REQUIRE_2FA, LOGIN_SCREEN_WAYLAND),
// src/server/connection.rs: send_login_error call sites 1415, 1437, 1469, 2841/3164, 2930-2969,
// 2996, 3057, 3083, 3127, 4297, 4568, 4579 and set_error 2056-2063/2151;
// rustdesk 1.2.5 flutter/web/js/src/consts.ts (desktop-session strings, Linux login screen).
const EXACT: Record<string, SessionErrorCode> = {
  "Wrong Password": "WRONG_PASSWORD",
  "Empty Password": "PASSWORD_REQUIRED",
  "No Password Access": "NO_PASSWORD_ACCESS",
  "2FA Required": "TWO_FACTOR_REQUIRED",
  "Wrong 2FA Code": "WRONG_TWO_FACTOR",
  "Too many wrong attempts": "TOO_MANY_ATTEMPTS",
  "Please try 1 minute later": "TOO_MANY_ATTEMPTS",
  Offline: "OFFLINE",
  "Your ip is blocked by the peer": "BLOCKED",
  "Your ID is blocked by the peer": "BLOCKED",
  "Connection not allowed": "NOT_ALLOWED",
  "Supported only in the installed version.": "NOT_ALLOWED",
  "Someone turns on privacy mode, exit": "PRIVACY_MODE",
  "Wayland login screen is not supported": "NO_SCREEN",
  "Desktop session not ready": "NO_SCREEN",
  "Desktop xsession failed": "NO_SCREEN",
  "Desktop session another user login": "NO_SCREEN",
  "Desktop xorg not found": "NO_SCREEN",
  "Desktop none": "NO_SCREEN",
  "Desktop session not ready, password empty": "NO_SCREEN",
  "Desktop session not ready, password wrong": "NO_SCREEN",
};

/** Maps a LoginResponse.error string to a typed error; unknown text becomes PEER_ERROR. */
export function loginErrorFromPeer(text: string): SessionError {
  let code = EXACT[text];
  if (code === undefined) {
    if (text.startsWith("Too many wrong attempts")) code = "TOO_MANY_ATTEMPTS";
    else if (text.startsWith("No permission of ")) code = "NOT_ALLOWED";
    else if (
      text.startsWith("Unsupported display server type") ||
      text.includes("x11 expected")
    )
      code = "NO_SCREEN";
    else code = "PEER_ERROR";
  }
  return new SessionError(
    code,
    code === "PEER_ERROR" ? `peer error: ${text}` : undefined,
    text,
  );
}
