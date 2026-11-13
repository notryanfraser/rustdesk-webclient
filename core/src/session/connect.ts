// The full consumer pipeline:
// idServerUrl -> requestRelay -> verifyServerSignedIdPk -> relay connect -> RequestRelay
// -> secureHandshake -> login -> Session
// Each layer's typed errors (RendezvousError, SecureError, SessionError, plain connect errors)
// propagate unchanged; every socket opened here is closed on failure. Reference flow:
// rustdesk 1.2.5 flutter/web/js/src/connection.ts `_start` 91-143, `connectRelay` 145-171.

import {
  buildRequestRelay,
  defaultRelayUrl,
  idServerUrl,
  relayUrl,
  requestRelay,
} from "../rendezvous/index.js";
import type { RelayAssignment } from "../rendezvous/index.js";
import { ConnType } from "../gen/rendezvous_pb.js";
import { secureHandshake, verifyServerSignedIdPk } from "../crypto/index.js";
import { connectWs } from "../transport/ws.js";
import type { ConnectFn, FrameTransport } from "../transport/types.js";
import { encodeCloseReason } from "./codec.js";
import { login, noDisplayError } from "./login.js";
import type { LoginOptions, LoginResult } from "./login.js";
import { Session } from "./session.js";
import type { SessionOptions } from "./session.js";

export interface ConnectSessionOptions
  extends
    Pick<
      LoginOptions,
      | "myId"
      | "myName"
      | "myPlatform"
      | "version"
      | "option"
      | "fileTransfer"
      | "osLogin"
      | "onWaitingForApproval"
    >,
    SessionOptions {
  /** Configured ID server as the user would type it: "host" or "host:port" (see idServerUrl). */
  idServer: string;
  /** hbbs public key, base64 (id_ed25519.pub). Also sent as licence_key. */
  serverKey: string;
  peerId: string;
  password: string;
  /** Selects wss:// vs ws://. Pass it explicitly when the page origin is not the final scheme (e.g. http://localhost test pages). */
  pageIsHttps: boolean;
  /**
   * Throw SessionError NO_DISPLAY (and close the session) when the peer reports no displays.
   * Default false: like the reference, a zero-display login succeeds and
   * `login.noDisplay` / `session.noDisplay` is true.
   */
  requireDisplay?: boolean;
  /** Account access token for hbbs (PunchHoleRequest.token). */
  token?: string;
  /** Socket opener; default connectWs. */
  connect?: ConnectFn;
  /** Per-stage deadlines in ms. */
  timeouts?: {
    /** Each WebSocket open. Default 10000. */
    connectMs?: number;
    /** hbbs answer. Default 15000. */
    rendezvousMs?: number;
    /** Peer SignedId. Default 15000. */
    handshakeMs?: number;
    /** LoginResponse. Default 30000. */
    loginMs?: number;
    /** Extra time allowed once the peer asks for on-screen approval. Default 180000. */
    approvalMs?: number;
  };
}

export interface ConnectedSession {
  session: Session;
  /** What hbbs told us (relay address, peer version) and the login result, for diagnostics. */
  assignment: RelayAssignment;
  login: LoginResult;
  idUrl: string;
  relayUrl: string;
}

export async function connectSession(
  opts: ConnectSessionOptions,
): Promise<ConnectedSession> {
  const connect = opts.connect ?? connectWs;
  const connectMs = opts.timeouts?.connectMs ?? 10_000;

  const idUrl = idServerUrl(opts.idServer, opts.pageIsHttps);
  const idSocket = await connect(idUrl, { timeoutMs: connectMs });
  let assignment: RelayAssignment;
  try {
    assignment = await requestRelay(
      idSocket,
      {
        peerId: opts.peerId,
        licenceKey: opts.serverKey,
        token: opts.token,
        // A file-transfer session says so to hbbs too, as the native client does.
        connType: opts.fileTransfer ? ConnType.FILE_TRANSFER : undefined,
      },
      { timeoutMs: opts.timeouts?.rendezvousMs },
    );
  } finally {
    idSocket.close(); // the reference closes right after the answer (connection.ts:119)
  }

  // Fail before opening a relay socket if hbbs's signed IdPk does not verify.
  verifyServerSignedIdPk(assignment.pk, opts.serverKey, opts.peerId);

  // connection.ts:146-151: relay_server -> getrUriFromRs(.., true, 2), else the default.
  const rUrl = assignment.relayServer
    ? relayUrl(assignment.relayServer, opts.pageIsHttps)
    : defaultRelayUrl(opts.idServer, opts.pageIsHttps);
  const relay: FrameTransport = await connect(rUrl, { timeoutMs: connectMs });
  let secure: FrameTransport;
  try {
    relay.send(buildRequestRelay(assignment.uuid, opts.serverKey));
    secure = await secureHandshake(relay, assignment, {
      serverKey: opts.serverKey,
      peerId: opts.peerId,
      timeoutMs: opts.timeouts?.handshakeMs,
    });
  } catch (e) {
    relay.close(1008, "connect failed");
    throw e;
  }

  const loginResult = await login(secure, {
    peerId: opts.peerId,
    password: opts.password,
    myId: opts.myId,
    myName: opts.myName,
    myPlatform: opts.myPlatform,
    version: opts.version,
    option: opts.option,
    fileTransfer: opts.fileTransfer,
    osLogin: opts.osLogin,
    onWaitingForApproval: opts.onWaitingForApproval,
    timeoutMs: opts.timeouts?.loginMs,
    approvalTimeoutMs: opts.timeouts?.approvalMs,
  });
  if (opts.requireDisplay && loginResult.noDisplay) {
    // Say goodbye properly and drop the channel.
    secure.send(encodeCloseReason());
    secure.close(1000, "no display");
    throw noDisplayError();
  }
  const session = new Session(secure, loginResult, {
    autoAckVideo: opts.autoAckVideo,
    idleTimeoutMs: opts.idleTimeoutMs,
    onEvent: opts.onEvent,
  });
  return { session, assignment, login: loginResult, idUrl, relayUrl: rUrl };
}
