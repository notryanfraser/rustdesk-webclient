import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TransportClosedError,
  TransportTimeoutError,
  WS_HIGH_WATER_MARK,
  WsTransport,
  connectWs,
  makeConnect,
  type WebSocketLike,
} from "../src/index.js";

class FakeWs implements WebSocketLike {
  static last: FakeWs;
  static autoOpen = true;
  binaryType = "blob";
  bufferedAmount = 0;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onerror: WebSocketLike["onerror"] = null;
  onclose: WebSocketLike["onclose"] = null;
  sent: Uint8Array[] = [];
  closeCalls = 0;
  constructor(readonly url: string) {
    FakeWs.last = this;
    if (FakeWs.autoOpen) queueMicrotask(() => this.onopen?.({}));
  }
  send(d: Uint8Array) {
    this.sent.push(d);
  }
  close(code = 1000, reason = "") {
    this.closeCalls++;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
  // test helpers
  deliver(...bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
}

const connect = makeConnect(FakeWs);
const b = (...n: number[]) => new Uint8Array(n);

beforeEach(() => {
  FakeWs.autoOpen = true;
});

describe("WsTransport", () => {
  it("delivers frames FIFO, sets arraybuffer binaryType", async () => {
    const t = await connect("wss://x");
    expect(FakeWs.last.binaryType).toBe("arraybuffer");
    FakeWs.last.deliver(1);
    FakeWs.last.deliver(2);
    FakeWs.last.deliver(3);
    expect(await t.recv()).toEqual(b(1));
    expect(await t.recv()).toEqual(b(2));
    expect(await t.recv()).toEqual(b(3));
  });

  it("serves concurrent recv() calls in call order", async () => {
    const t = await connect("wss://x");
    const ps = [t.recv(), t.recv(), t.recv()];
    FakeWs.last.deliver(1);
    FakeWs.last.deliver(2);
    FakeWs.last.deliver(3);
    expect(await Promise.all(ps)).toEqual([b(1), b(2), b(3)]);
  });

  it("timed-out recv does not steal a later frame", async () => {
    vi.useFakeTimers();
    try {
      const t = await connect("wss://x");
      const timed = t.recv(50);
      const timedAssert = expect(timed).rejects.toBeInstanceOf(
        TransportTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(60);
      await timedAssert;
      const next = t.recv();
      FakeWs.last.deliver(9);
      expect(await next).toEqual(b(9));
    } finally {
      vi.useRealTimers();
    }
  });

  it("recv with timeout resolves if frame arrives in time", async () => {
    const t = await connect("wss://x");
    const p = t.recv(1000);
    FakeWs.last.deliver(5);
    expect(await p).toEqual(b(5));
  });

  it("ignores text frames", async () => {
    const t = await connect("wss://x");
    FakeWs.last.onmessage?.({ data: "hello" });
    FakeWs.last.deliver(7);
    expect(await t.recv()).toEqual(b(7));
  });

  it("drains queued frames after close, then rejects", async () => {
    const t = await connect("wss://x");
    FakeWs.last.deliver(1);
    FakeWs.last.deliver(2);
    FakeWs.last.onclose?.({ code: 1006, reason: "gone" });
    expect(await t.recv()).toEqual(b(1));
    expect(await t.recv()).toEqual(b(2));
    const err = await t.recv().catch((e) => e);
    expect(err).toBeInstanceOf(TransportClosedError);
    expect((err as TransportClosedError).info).toEqual({
      code: 1006,
      reason: "gone",
      local: false,
    });
  });

  it("pending recv rejects when the socket closes", async () => {
    const t = await connect("wss://x");
    const p = t.recv();
    FakeWs.last.onclose?.({ code: 1001, reason: "" });
    await expect(p).rejects.toBeInstanceOf(TransportClosedError);
  });

  it("send after close throws TransportClosedError", async () => {
    const t = await connect("wss://x");
    t.send(b(1));
    expect(FakeWs.last.sent).toEqual([b(1)]);
    t.close();
    expect(() => t.send(b(2))).toThrow(TransportClosedError);
  });

  it("close is idempotent, local:true, closed resolves once", async () => {
    const t = await connect("wss://x");
    const ws = FakeWs.last;
    t.close(1000, "bye");
    t.close(1001, "again");
    await Promise.resolve();
    expect(ws.closeCalls).toBe(1);
    expect(await t.closed).toEqual({ code: 1000, reason: "bye", local: true });
    // late onclose from the socket must not change anything
    ws.onclose?.({ code: 1006, reason: "late" });
    expect(await t.closed).toEqual({ code: 1000, reason: "bye", local: true });
  });

  it("drained() resolves immediately below the high-water mark", async () => {
    const t = (await connect("wss://x")) as WsTransport;
    await expect(t.drained()).resolves.toBeUndefined();
  });

  it("drained() waits for bufferedAmount to fall, rejects on close", async () => {
    const t = (await connect("wss://x")) as WsTransport;
    FakeWs.last.bufferedAmount = WS_HIGH_WATER_MARK + 1;
    let done = false;
    const p = t.drained().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    FakeWs.last.bufferedAmount = 0;
    await p;
    expect(done).toBe(true);

    FakeWs.last.bufferedAmount = WS_HIGH_WATER_MARK + 1;
    const q = t.drained();
    const assertion = expect(q).rejects.toBeInstanceOf(TransportClosedError);
    t.close();
    await assertion;
  });
});

describe("connect", () => {
  it("rejects on timeout and closes the socket", async () => {
    FakeWs.autoOpen = false;
    await expect(connect("wss://x", { timeoutMs: 20 })).rejects.toThrow(
      /timed out/,
    );
    expect(FakeWs.last.closeCalls).toBe(1);
  });

  it("rejects on error", async () => {
    FakeWs.autoOpen = false;
    const p = connect("wss://x");
    FakeWs.last.onerror?.({});
    await expect(p).rejects.toThrow(/error/);
  });

  it("rejects on close before open", async () => {
    FakeWs.autoOpen = false;
    const p = connect("wss://x");
    FakeWs.last.onclose?.({ code: 1006, reason: "" });
    await expect(p).rejects.toThrow(/closed before open \(1006\)/);
  });
});

const live = (globalThis as { process?: { env: Record<string, string> } })
  .process?.env.RUSTDESK_LIVE;

describe.skipIf(live !== "1")("live smoke", () => {
  it("connects to the ID server over wss and closes cleanly", async () => {
    const t = await connectWs("wss://rustdesk-id.example.net:443/", {
      timeoutMs: 10000,
    });
    t.close();
    const info = await t.closed;
    expect(info.local).toBe(true);
    expect(() => t.send(b(1))).toThrow(TransportClosedError);
  });
});
