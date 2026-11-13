// WebSocket implementation of FrameTransport (see ./types.ts for the contract).
// One protocol message per binary frame; text frames are ignored. No protobuf,
// no crypto here.

import { TransportError } from "../errors.js";
import {
  TransportClosedError,
  TransportTimeoutError,
  type CloseInfo,
  type ConnectFn,
  type FrameTransport,
} from "./types.js";

/** `bufferedAmount` above this means callers should await `drained()`. */
export const WS_HIGH_WATER_MARK = 4 * 1024 * 1024;

/** The subset of the WebSocket API this module uses (lets tests inject a fake). */
export interface WebSocketLike {
  binaryType: string;
  readonly bufferedAmount: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

interface Waiter {
  resolve: (frame: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DRAIN_POLL_MS = 10;

export class WsTransport implements FrameTransport {
  readonly closed: Promise<CloseInfo>;
  private resolveClosed!: (info: CloseInfo) => void;
  private info: CloseInfo | undefined;
  private readonly queue: Uint8Array[] = [];
  private readonly waiters: Waiter[] = [];

  /** `ws` must already be open. */
  constructor(private readonly ws: WebSocketLike) {
    this.closed = new Promise((r) => (this.resolveClosed = r));
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {};
    ws.onclose = (ev) =>
      this.finish({ code: ev.code, reason: ev.reason, local: false });
    // Socket may have closed between open and construction.
  }

  send(frame: Uint8Array): void {
    if (this.info) throw new TransportClosedError(this.info);
    this.ws.send(frame);
  }

  recv(timeoutMs?: number): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.info) return Promise.reject(new TransportClosedError(this.info));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: undefined };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new TransportTimeoutError(timeoutMs));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.info) return;
    this.finish({ code, reason, local: true });
    try {
      this.ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  /** Bytes queued in the socket but not yet sent. */
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /**
   * Resolves once `bufferedAmount` is at or below the high-water mark (immediately
   * if it already is). Rejects with TransportClosedError if the transport closes
   * first. `send` never blocks; callers that care about backpressure await this.
   */
  async drained(): Promise<void> {
    while (this.ws.bufferedAmount > WS_HIGH_WATER_MARK) {
      if (this.info) throw new TransportClosedError(this.info);
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
    if (this.info) throw new TransportClosedError(this.info);
  }

  private onMessage(data: unknown): void {
    let frame: Uint8Array;
    if (data instanceof ArrayBuffer) frame = new Uint8Array(data);
    else if (ArrayBuffer.isView(data))
      frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return; // text (or anything else) frames are ignored
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.queue.push(frame);
    }
  }

  private finish(info: CloseInfo): void {
    if (this.info) return;
    this.info = info;
    this.ws.onmessage = null;
    // Waiters only exist while the queue is empty, so draining order is safe.
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new TransportClosedError(info));
    }
    this.resolveClosed(info);
  }
}

/** Build a ConnectFn around any WebSocket-compatible constructor. */
export function makeConnect(Ctor: WebSocketCtor): ConnectFn {
  return (url, opts) =>
    new Promise<WsTransport>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ws: WebSocketLike;
      const fail = (err: Error, closeSocket: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.onopen = ws.onerror = ws.onclose = null;
        if (closeSocket) {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
        reject(err);
      };
      try {
        ws = new Ctor(url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      ws.binaryType = "arraybuffer";
      if (opts?.timeoutMs !== undefined) {
        const ms = opts.timeoutMs;
        timer = setTimeout(
          () =>
            fail(
              new TransportError(
                "CONNECT_TIMEOUT",
                `connect to ${url} timed out after ${ms} ms`,
              ),
              true,
            ),
          ms,
        );
      }
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new WsTransport(ws));
      };
      ws.onerror = () =>
        fail(
          new TransportError(
            "CONNECT_FAILED",
            `WebSocket error connecting to ${url}`,
          ),
          true,
        );
      ws.onclose = (ev) =>
        fail(
          new TransportError(
            "CONNECT_FAILED",
            `WebSocket closed before open (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`,
          ),
          false,
        );
    });
}

/** Connect using the global `WebSocket` (browsers, Node 22+). */
export const connectWs: ConnectFn = (url, opts) =>
  makeConnect(WebSocket as unknown as WebSocketCtor)(url, opts);
