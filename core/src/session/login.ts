// Peer authentication: Hash -> LoginRequest -> LoginResponse.
//
// Reference flow: rustdesk 1.2.5 flutter/web/js/src/connection.ts `msgLoop()` 236-241 (Hash:
// remember it, then `login()`), 242-247 (TestDelay echo), 248-249 + `handleLoginResponse()`
// 311-396 (error vs peer_info), `_sendLoginMessage()` 465-478 (LoginRequest fields).
// Peer side (what must be satisfied): rustdesk 1.5.3 src/server/connection.rs `on_message`
// 2888-3130 and `send_logon_response_and_keep_alive` 1852-2250 (see ./errors.ts for the error
// strings).

import { create } from "@bufbuild/protobuf";
import {
  FileTransferSchema,
  LoginRequestSchema,
  MessageSchema,
  type LoginResponse,
  type Message,
  type OptionMessage,
  type OSLogin,
  type PeerInfo,
} from "../gen/message_pb.js";
import {
  TransportClosedError,
  TransportTimeoutError,
} from "../transport/types.js";
import type { FrameTransport } from "../transport/types.js";
import { SecureError } from "../crypto/errors.js";
import { decodeMessage, encodeCloseReason, encodeMessage } from "./codec.js";
import { SessionError, loginErrorFromPeer } from "./errors.js";
import { hashPassword } from "./hash.js";

export interface LoginParams {
  /** The peer ID being logged into. */
  peerId: string;
  /** Plain-text password; only ever hashed, never put on the wire. */
  password: string;
  /** The Hash message the peer sent. */
  hash: { salt: string; challenge: string };
  /** Our ID shown on the peer. Default "web" (reference). */
  myId?: string;
  /** Our display name shown on the peer. Default "web" (reference). */
  myName?: string;
  /** Default "Web". */
  myPlatform?: string;
  /**
   * Client version string. Default: omitted, like the 1.2.5 web client. A peer keys legacy
   * behaviour off it (src/server/connection.rs:2309, 3054, 4679, 5075): below 1.2.4 it treats us
   * as an old client, which is what the reference is; set it only together with the features
   * that version implies (e.g. CaptureDisplays for >= multi-UI-session versions).
   */
  version?: string;
  option?: OptionMessage;
  osLogin?: OSLogin;
  /** Default true (reference). The peer then waits for Misc.video_received between frames. */
  videoAckRequired?: boolean;
  /**
   * Log in as a file-transfer session (LoginRequest.union = file_transfer{dir, show_hidden}).
   * A 1.5.3 peer handles FileAction only on such a session (src/server/connection.rs 3516-3525).
   */
  fileTransfer?: { dir?: string; showHidden?: boolean };
}

/**
 * LoginRequest exactly as the 1.2.5 web client builds it (connection.ts:465-478):
 * username = peer ID. REQUIRED: a peer answers "Offline" unless it equals its own ID
 * (src/server/connection.rs:2992-2996).
 * password = SHA256(SHA256(password||salt)||challenge) (./hash.ts). REQUIRED non-empty:
 * an empty one parks the connection waiting for on-screen approval (3062-3066).
 * my_id, my_name = "web", "web" (reference "to-do"). Shown in the peer's connection manager;
 * my_id also keys the peer's session table (5806-5812) and its optional
 * ID allow-list (1448-1475).
 * option = only when the caller supplies one (reference: only if some option is set).
 * video_ack_required= true (reference). Without it the peer streams without waiting for acks
 * (1080-1084); with it, Session acks each VideoFrame.
 * os_login = only when supplied.
 * Additions the reference does not make, justified by the 1.5.3 peer/native client:
 * my_platform = "Web". The native client always sets it (src/client.rs:3841-3866); the
 * peer uses it for the connection colour and clipboard/file-paste decisions
 * (2007-2016, 1134). Unknown values are harmless.
 * version = opt-in (see LoginParams.version).
 * Not set: session_id (0), hwid, avatar, trusted_device_v2_* (trusted-device enrolment is off).
 */
export function buildLoginRequest(p: LoginParams): Message {
  if (p.peerId === "")
    throw new SessionError("INVALID_ARGUMENT", "peerId is empty");
  if (p.password === "")
    throw new SessionError("PASSWORD_REQUIRED", "password is empty");
  return create(MessageSchema, {
    union: {
      case: "loginRequest",
      value: create(LoginRequestSchema, {
        username: p.peerId,
        password: hashPassword(p.password, p.hash.salt, p.hash.challenge),
        myId: p.myId ?? "web",
        myName: p.myName ?? "web",
        myPlatform: p.myPlatform ?? "Web",
        version: p.version ?? "",
        option: p.option,
        osLogin: p.osLogin,
        videoAckRequired: p.videoAckRequired ?? true,
        ...(p.fileTransfer
          ? {
              union: {
                case: "fileTransfer" as const,
                value: create(FileTransferSchema, {
                  dir: p.fileTransfer.dir ?? "",
                  showHidden: p.fileTransfer.showHidden ?? false,
                }),
              },
            }
          : {}),
      }),
    },
  });
}

export interface LoginOptions extends Omit<
  LoginParams,
  "hash" | "peerId" | "password"
> {
  peerId: string;
  password: string;
  /** Overall deadline from the first call to LoginResponse. Default 30000 ms. */
  timeoutMs?: number;
  /**
   * Called once when the peer answers "No Password Access": it only admits sessions someone
   * accepts on its screen (approve mode "click", or "both" with no valid password). This is NOT a
   * failure: the peer keeps the connection and sends the real LoginResponse (peer_info) once the
   * person clicks Accept. Show "waiting for the remote side to accept..." and keep going.
   * Reference: rustdesk 1.5.3 src/server/connection.rs:3045-3059 (sends the error, then
   * `return true` = keep the connection; the password is not even checked in this branch),
   * src/client.rs:4503-4509 (LOGIN_ERROR_MAP: msgtype "wait-remote-accept-nook", try_again: true)
   * and src/client/io_loop.rs:1751-1754 (a `true` from handle_login_error keeps the loop running).
   * Note the peer only sends this error to a client whose LoginRequest.version is >= 1.2.0 (the
   * check at connection.rs:3054); with our default (no version) it parks the connection silently,
   * so on such peers the callback never fires and login() ends in TIMEOUT. Set `version` to get
   * the notification.
   */
  onWaitingForApproval?: () => void;
  /**
   * Once waiting for approval, the deadline becomes at least this long from that moment. Default
   * 180000 ms = the peer's own LOGIN_GRACE (connection.rs:89, 178-185), after which it drops an
   * unauthorized connection. If it elapses, login() throws SessionError NO_PASSWORD_ACCESS.
   */
  approvalTimeoutMs?: number;
}

export const DEFAULT_LOGIN_TIMEOUT_MS = 30_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 180_000;
/** Cap on messages buffered during login for the Session to replay. */
const MAX_PENDING = 256;

export interface LoginResult {
  /** The successful LoginResponse (peer_info set). */
  response: LoginResponse;
  peerInfo: PeerInfo;
  /**
   * Messages the peer sent before the LoginResponse that login() does not consume (e.g.
   * Misc.permission_info). TestDelay and Hash are answered, not listed. A Session replays these
   * as its first events.
   */
  pending: Message[];
  /** TestDelay probes answered during login. */
  keepalivesAnswered: number;
  /** True if the peer asked for on-screen approval before it let us in (onWaitingForApproval fired). */
  waitedForApproval: boolean;
  /**
   * True when peer_info.displays is empty: login succeeded but there is nothing to show. The
   * reference treats it as a post-login error message and does not disconnect (see
   * SessionError NO_DISPLAY); use `noDisplayError()` to get a describeError-able error.
   */
  noDisplay: boolean;
}

/** A SessionError NO_DISPLAY, for consumers that want to treat a zero-display peer as a failure. */
export function noDisplayError(): SessionError {
  return new SessionError("NO_DISPLAY");
}

/**
 * Runs the login on an established secure channel. Reads from `secure` until the LoginResponse
 * (so it must be the only reader; Session takes over afterwards). On any failure the channel is
 * closed (after a best-effort close_reason) and a SessionError is thrown; success leaves it
 * open and idle. Never logs or returns the password.
 */
export async function login(
  secure: FrameTransport,
  opts: LoginOptions,
): Promise<LoginResult> {
  if (opts.peerId === "")
    throw new SessionError("INVALID_ARGUMENT", "peerId is empty");
  if (opts.password === "")
    throw new SessionError("PASSWORD_REQUIRED", "password is empty");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  let deadline = Date.now() + timeoutMs;
  let waiting = false;
  const pending: Message[] = [];
  let keepalivesAnswered = 0;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeoutError(timeoutMs);
      const frame = await secure.recv(remaining);
      let msg: Message;
      try {
        msg = decodeMessage(frame);
      } catch (e) {
        throw new SessionError("PROTOCOL", "undecodable message", undefined, {
          cause: e,
        });
      }
      const u = msg.union;
      switch (u.case) {
        case "hash":
          // connection.ts:239-244
          secure.send(
            encodeMessage(
              buildLoginRequest({
                ...opts,
                hash: { salt: u.value.salt, challenge: u.value.challenge },
              }),
            ),
          );
          break;
        case "testDelay":
          // connection.ts:245-250; peer: connection.rs:3132-3151
          if (!u.value.fromClient) {
            secure.send(encodeMessage(msg));
            keepalivesAnswered++;
          }
          break;
        case "loginResponse": {
          const r = u.value;
          if (r.union.case === "error") {
            const err = loginErrorFromPeer(r.union.value);
            if (err.code !== "NO_PASSWORD_ACCESS") throw err;
            // Non-terminal (see LoginOptions.onWaitingForApproval).
            if (!waiting) {
              waiting = true;
              deadline = Math.max(
                deadline,
                Date.now() +
                  (opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS),
              );
              try {
                opts.onWaitingForApproval?.();
              } catch {
                // a faulty callback must not abort the login
              }
            }
            break;
          }
          if (r.union.case === "peerInfo")
            return {
              response: r,
              peerInfo: r.union.value,
              pending,
              keepalivesAnswered,
              waitedForApproval: waiting,
              noDisplay: r.union.value.displays.length === 0,
            };
          // A LoginResponse with neither field: nothing to act on (handleLoginResponse ignores it).
          break;
        }
        case "misc":
          if (u.value.union.case === "closeReason")
            throw new SessionError(
              "PEER_CLOSED",
              `peer closed the connection: ${u.value.union.value}`,
              u.value.union.value,
            );
          if (pending.length < MAX_PENDING) pending.push(msg);
          break;
        default:
          if (pending.length < MAX_PENDING) pending.push(msg);
      }
    }
  } catch (e) {
    closeQuietly(secure);
    // Nobody clicked Accept in time: report the reason, not a generic timeout.
    if (waiting && e instanceof TransportTimeoutError)
      throw new SessionError("NO_PASSWORD_ACCESS", undefined, undefined, {
        cause: e,
      });
    throw toSessionError(e);
  }
}

function closeQuietly(t: FrameTransport): void {
  try {
    t.send(encodeCloseReason());
  } catch {
    // already closed or failed
  }
  t.close(1000, "login failed");
}

function toSessionError(e: unknown): unknown {
  if (e instanceof SessionError) return e;
  if (e instanceof TransportTimeoutError)
    return new SessionError("TIMEOUT", undefined, undefined, { cause: e });
  if (e instanceof TransportClosedError)
    return new SessionError("CLOSED", undefined, undefined, { cause: e });
  // SecureError (decrypt failure etc.) and anything unexpected.
  if (e instanceof SecureError)
    return new SessionError("PROTOCOL", e.message, undefined, { cause: e });
  return e;
}
