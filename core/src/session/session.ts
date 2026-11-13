// A logged-in session: owns the secure channel's single recv loop.
//
// What the peer needs from a controller to keep the session up (rustdesk 1.5.3
// src/server/connection.rs):
// * The peer drives liveness. Every second (TEST_DELAY_TIMEOUT 504, tick 1187-1211) it sends
// TestDelay{from_client=false} if its previous probe was answered (`last_test_delay`, 1193),
// and closes with reason "Timeout" if it has received NOTHING for 30 s (SEC30, 1188-1191;
// last_recv_time is refreshed by any frame, 1033). So the one obligation is: echo each
// TestDelay back unchanged (3132-3151: the peer clears last_test_delay on receipt, measures
// network_delay from it). The 1.2.5 reference does exactly that and nothing else: it never
// originates a ping (connection.ts msgLoop 242-247; native src/client.rs handle_test_delay
// 4268-4274 is identical). A TestDelay with from_client=true is one the peer would echo for
// us; we never send one, and ignore any we receive.
// * video_ack_required (set in LoginRequest) makes the peer wait for Misc.video_received after
// each frame before sending the next (1080-1084, 3949-3953; reference sendVideoReceived
// connection.ts 517-520, after decoding). Unless the video pipeline acks (VideoStream), the Session acks each
// VideoFrame itself (`autoAckVideo`, default true) so the stream does not stall.
// * Unauthenticated limits do not apply once authorized (LOGIN_GRACE 180 s is login-only, 87-89).
//
// Closing. The peer sends Misc.close_reason(text) before it drops a session it ends itself
// (connection.rs send_close_reason_no_retry 5346-5358: "Closed manually by the peer", "Connection
// failed due to inactivity" 1178, "Connection not allowed" 5875, ...); the reference shows the
// text and closes (connection.ts handleMisc 637-641) and so do we (SessionClosed kind "peer").
// To leave, the 1.5.3 native client sends Misc{close_reason: ""} then drops the stream
// (io_loop.rs 669-679, 759-761); the peer treats it as "Peer close" (connection.rs 2890-2897).
// The 1.2.5 web client just closes the socket. close() does the native thing.

import type { Message } from "../gen/message_pb.js";
import {
  TransportClosedError,
  TransportTimeoutError,
} from "../transport/types.js";
import type { CloseInfo, FrameTransport } from "../transport/types.js";
import { SecureError } from "../crypto/errors.js";
import {
  decodeMessage,
  encodeCloseReason,
  encodeMessage,
  encodeUnion,
} from "./codec.js";
import { SessionError } from "./errors.js";
import type { LoginResult } from "./login.js";
import { create } from "@bufbuild/protobuf";
import { MiscSchema } from "../gen/message_pb.js";

export type SessionCloseKind =
  /** close() was called here. */
  | "local"
  /** The peer sent Misc.close_reason (text in `peerReason`). */
  | "peer"
  /** The socket closed without us asking (code/reason in `transport`). */
  | "transport"
  /** Nothing at all from the peer for `idleTimeoutMs` (the peer pings once a second). */
  | "timeout"
  /** Secure-channel failure (tamper / counter desync) or undecodable message; see `error`. */
  | "error";

export interface SessionClosed {
  kind: SessionCloseKind;
  message: string;
  peerReason?: string;
  transport?: CloseInfo;
  error?: Error;
}

export type SessionEvent =
  | { type: "message"; message: Message }
  | { type: "closed"; closed: SessionClosed };

export interface SessionStats {
  /** TestDelay probes echoed back. */
  keepalivesAnswered: number;
  /** Every message received after login (including TestDelay), plus replayed pre-login ones. */
  messagesReceived: number;
  /** Count per Message.union case name ("videoFrame", "misc", ...). */
  byType: Record<string, number>;
  /** Misc.video_received acks sent by autoAckVideo. */
  videoAcksSent: number;
  /** Secure-channel frame counters, when the channel exposes them. */
  counters?: { send: number; recv: number };
}

export interface SessionOptions {
  /** Ack every VideoFrame with Misc.video_received. Default true; the app turns it off and lets VideoStream ack. */
  autoAckVideo?: boolean;
  /** Close with kind "timeout" after this long without any frame. Default 30000 (the peer's own limit). */
  idleTimeoutMs?: number;
  /** Registered before the loop starts, so no event is missed. Receives replayed pre-login messages first. */
  onEvent?: (e: SessionEvent) => void;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export class Session {
  readonly peerInfo: LoginResult["peerInfo"];
  /** peer_info.displays is empty: logged in, but there is nothing to capture (see NO_DISPLAY). */
  readonly noDisplay: boolean;
  /** Resolves once, never rejects. */
  readonly closed: Promise<SessionClosed>;

  private resolveClosed!: (c: SessionClosed) => void;
  private finished: SessionClosed | undefined;
  private localClose = false;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly counts = {
    keepalivesAnswered: 0,
    messagesReceived: 0,
    videoAcksSent: 0,
  };
  private readonly byType: Record<string, number> = {};
  private readonly autoAckVideo: boolean;
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly secure: FrameTransport,
    login: LoginResult,
    opts: SessionOptions = {},
  ) {
    this.peerInfo = login.peerInfo;
    this.noDisplay = login.noDisplay;
    this.autoAckVideo = opts.autoAckVideo ?? true;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.closed = new Promise((r) => (this.resolveClosed = r));
    this.counts.keepalivesAnswered = login.keepalivesAnswered;
    if (opts.onEvent) this.listeners.add(opts.onEvent);
    for (const m of login.pending) this.emitMessage(m);
    void this.run();
  }

  get stats(): SessionStats {
    const c = (this.secure as { counters?: { send: number; recv: number } })
      .counters;
    return {
      ...this.counts,
      byType: { ...this.byType },
      ...(c ? { counters: { ...c } } : {}),
    };
  }

  get isClosed(): boolean {
    return this.finished !== undefined;
  }

  /** Subscribe to events from now on. Returns the unsubscribe function. */
  on(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Async iterator over events from the moment of this call; ends after the single
   * `closed` event. Events are queued unboundedly until read; call only if you consume it.
   */
  events(): AsyncIterable<SessionEvent> {
    const queue: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const off = this.on((e) => {
      queue.push(e);
      if (e.type === "closed") {
        done = true;
        off();
      }
      wake?.();
    });
    if (this.finished && !done) {
      queue.push({ type: "closed", closed: this.finished });
      done = true;
      off();
    }
    return {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<SessionEvent>> {
          for (;;) {
            const e = queue.shift();
            if (e) return { value: e, done: false };
            if (done) return { value: undefined, done: true };
            await new Promise<void>((r) => (wake = r));
            wake = undefined;
          }
        },
        async return(): Promise<IteratorResult<SessionEvent>> {
          off();
          done = true;
          queue.length = 0;
          return { value: undefined, done: true };
        },
      }),
    };
  }

  /** Send a protocol message (input events etc.). Throws SESSION_CLOSED once closed. */
  send(msg: Message): void {
    if (this.finished) throw new SessionError("SESSION_CLOSED");
    this.secure.send(encodeMessage(msg));
  }

  /** Resolves when the socket's send buffer is under its high-water mark (bulk senders). */
  drained(): Promise<void> {
    return this.secure.drained?.() ?? Promise.resolve();
  }

  /**
   * Leave gracefully: send Misc{close_reason:""} (as the native client does), close the socket,
   * resolve with the SessionClosed (kind "local" unless the session had already ended).
   */
  async close(code = 1000, reason = "session closed"): Promise<SessionClosed> {
    if (!this.finished && !this.localClose) {
      this.localClose = true;
      try {
        this.secure.send(encodeCloseReason());
      } catch {
        // channel already dead
      }
      this.secure.close(code, reason);
    }
    return this.closed;
  }

  private async run(): Promise<void> {
    let result: SessionClosed;
    try {
      result = await this.loop();
    } catch (e) {
      result = this.classify(e);
    }
    this.finish(result);
  }

  private async loop(): Promise<SessionClosed> {
    for (;;) {
      const frame = await this.secure.recv(this.idleTimeoutMs);
      let msg: Message;
      try {
        msg = decodeMessage(frame);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return {
          kind: "error",
          message: "undecodable message from the peer",
          error: err,
        };
      }
      const closed = this.dispatch(msg);
      if (closed) return closed;
    }
  }

  /** Returns a SessionClosed when the message ends the session. */
  private dispatch(msg: Message): SessionClosed | undefined {
    const u = msg.union;
    switch (u.case) {
      case "testDelay":
        // connection.ts:245-250. from_client probes are ours to originate; none are ever sent.
        if (!u.value.fromClient) {
          this.secure.send(encodeMessage(msg));
          this.counts.keepalivesAnswered++;
        }
        // Echo first, then tell listeners: the probe carries the peer's view of the link
        // (last_delay ms, target_bitrate), which drives its frame rate (video_qos.rs).
        this.emitMessage(msg);
        return undefined;
      case "misc":
        if (u.value.union.case === "closeReason") {
          this.count(msg);
          const reason = u.value.union.value;
          // connection.ts:637-641: report and close; the peer is closing too.
          this.secure.close(1000, "peer closed");
          return {
            kind: "peer",
            message: `peer closed the session: ${reason}`,
            peerReason: reason,
          };
        }
        break;
      case "videoFrame":
        if (this.autoAckVideo) {
          this.secure.send(
            encodeUnion({
              case: "misc",
              value: create(MiscSchema, {
                union: { case: "videoReceived", value: true },
              }),
            }),
          );
          this.counts.videoAcksSent++;
        }
        break;
      default:
    }
    this.emitMessage(msg);
    return undefined;
  }

  private count(msg: Message): void {
    const k = msg.union.case ?? "empty";
    this.counts.messagesReceived++;
    this.byType[k] = (this.byType[k] ?? 0) + 1;
  }

  private emitMessage(msg: Message): void {
    this.count(msg);
    this.notify({ type: "message", message: msg });
  }

  private notify(e: SessionEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // a faulty listener must not kill the recv loop
      }
    }
  }

  private classify(e: unknown): SessionClosed {
    if (e instanceof TransportClosedError)
      return e.info.local || this.localClose
        ? { kind: "local", message: "closed locally", transport: e.info }
        : {
            kind: "transport",
            message: e.message,
            transport: e.info,
            error: e,
          };
    if (e instanceof TransportTimeoutError)
      return {
        kind: "timeout",
        message: `no frame from the peer for ${this.idleTimeoutMs} ms`,
        error: e,
      };
    if (e instanceof SecureError)
      return { kind: "error", message: e.message, error: e };
    const err = e instanceof Error ? e : new Error(String(e));
    return { kind: "error", message: err.message, error: err };
  }

  private finish(c: SessionClosed): void {
    if (this.finished) return;
    this.finished = c;
    // Always leave the socket closed (no-op if it already is).
    this.secure.close(1000, "session ended");
    this.resolveClosed(c);
    this.notify({ type: "closed", closed: c });
    this.listeners.clear();
  }
}
