// FileSession against a scripted peer: the message sequences observed live,
// compressed blocks, end-of-file markers, done/error/cancel,
// upload pacing and the peer's confirming done.
import raw from "../fixtures/zstd-vectors.json?raw";
import { describe, expect, it } from "vitest";
import {
  FILE_BLOCK_SIZE,
  FileDirectorySchema,
  FileEntrySchema,
  FileJobError,
  FileResponseSchema,
  FileSession,
  FileTransferBlockSchema,
  FileTransferDoneSchema,
  FileTransferErrorSchema,
  FileType,
  MessageSchema,
  TestDelaySchema,
  create,
  type FileResponse,
  type Message,
  type SessionEvent,
} from "../src/index.js";

const vec = (JSON.parse(raw) as { vectors: { name: string; frame: string }[] })
  .vectors;
const frame = (n: string) =>
  Uint8Array.from(atob(vec.find((v) => v.name === n)!.frame), (c) =>
    c.charCodeAt(0),
  );

function rig() {
  const sent: Message[] = [];
  let drains = 0;
  const fs: FileSession = new FileSession({
    send: (m) => {
      sent.push(m);
      // The peer echoes a client TestDelay (connection.rs 3132-3136): FileSession's cancel barrier.
      if (m.union.case === "testDelay")
        queueMicrotask(() =>
          fs.onEvent({ type: "message", message: m } as SessionEvent),
        );
    },
    drained: async () => {
      drains++;
    },
  });
  const peer = (union: FileResponse["union"]) =>
    fs.onEvent({
      type: "message",
      message: create(MessageSchema, {
        union: {
          case: "fileResponse",
          value: create(FileResponseSchema, { union }),
        },
      }),
    } as SessionEvent);
  const actions = () =>
    sent
      .filter((m) => m.union.case === "fileAction")
      .map(
        (m) =>
          (m.union.value as { union: { case: string; value: unknown } }).union,
      );
  const responses = () =>
    sent
      .filter((m) => m.union.case === "fileResponse")
      .map((m) => (m.union.value as FileResponse).union);
  return { fs, peer, actions, responses, drains: () => drains };
}
const entry = (name: string, size: number) =>
  create(FileEntrySchema, {
    entryType: FileType.File,
    name,
    size: BigInt(size),
  });
const flush = () => new Promise((r) => setTimeout(r, 0));
const flush_ = flush;

describe("FileSession.listDir", () => {
  it("sends read_dir and resolves with the listing for that path, ignoring others", async () => {
    const { fs, peer, actions } = rig();
    const p = fs.listDir("/config/m4-test");
    expect(actions()[0]).toMatchObject({
      case: "readDir",
      value: { path: "/config/m4-test", includeHidden: false },
    });
    peer({
      case: "dir",
      value: create(FileDirectorySchema, {
        id: 0,
        path: "/config",
        entries: [],
      }),
    }); // unasked login listing
    peer({
      case: "dir",
      value: create(FileDirectorySchema, {
        id: 0,
        path: "/config/m4-test",
        entries: [entry("a", 1)],
      }),
    });
    expect((await p).entries.map((e) => e.name)).toEqual(["a"]);
  });

  it('"" (home) resolves with the listing the peer answers with its real path', async () => {
    const { fs, peer } = rig();
    const named = fs.listDir("/tmp");
    const home = fs.listDir("");
    peer({
      case: "dir",
      value: create(FileDirectorySchema, {
        id: 0,
        path: "C:\\Users\\me",
        entries: [entry("Desktop", 0)],
      }),
    });
    peer({
      case: "dir",
      value: create(FileDirectorySchema, { id: 0, path: "/tmp", entries: [] }),
    });
    expect((await home).path).toBe("C:\\Users\\me");
    expect((await named).path).toBe("/tmp");
  });

  it("an error for id 0 rejects the oldest pending listing", async () => {
    const { fs, peer } = rig();
    const p = fs.listDir("/nope");
    peer({
      case: "error",
      value: create(FileTransferErrorSchema, { id: 0, error: "No such file" }),
    });
    await expect(p).rejects.toMatchObject({
      kind: "remote",
      message: "No such file",
    });
  });
});

describe("FileSession.download", () => {
  it("follows dir -> blocks (zstd and plain) -> empty end-of-file blocks -> done", async () => {
    const { fs, peer, actions } = rig();
    const log: string[] = [];
    const chunks: Record<number, number> = {};
    const job = fs.download("/d", {
      begin: (files) =>
        void log.push(`begin ${files.map((f) => f.name).join(",")}`),
      write: async (n, d) => {
        await flush(); // a slow sink: order must still hold
        chunks[n] = (chunks[n] ?? 0) + d.length;
        log.push(`write ${n} ${d.length}`);
      },
      endFile: (n) => void log.push(`end ${n}`),
    });
    expect(actions()[0]).toMatchObject({
      case: "send",
      value: { id: job.id, path: "/d", fileNum: 0 },
    });
    peer({
      case: "dir",
      value: create(FileDirectorySchema, {
        id: job.id,
        path: "/d",
        entries: [entry("sub/x.txt", 65536), entry("b", 15)],
      }),
    });
    peer({
      case: "block",
      value: create(FileTransferBlockSchema, {
        id: job.id,
        fileNum: 0,
        data: frame("text-64k-l3"),
        compressed: true,
      }),
    });
    peer({
      case: "block",
      value: create(FileTransferBlockSchema, {
        id: job.id,
        fileNum: 0,
        data: new Uint8Array(0),
      }),
    });
    peer({
      case: "block",
      value: create(FileTransferBlockSchema, {
        id: job.id,
        fileNum: 1,
        data: new TextEncoder().encode("hello clipboard"),
      }),
    });
    peer({
      case: "block",
      value: create(FileTransferBlockSchema, {
        id: job.id,
        fileNum: 1,
        data: new Uint8Array(0),
      }),
    });
    peer({
      case: "done",
      value: create(FileTransferDoneSchema, { id: job.id, fileNum: 2 }),
    });
    await job.done;
    expect(log).toEqual([
      "begin sub/x.txt,b",
      "write 0 65536",
      "end 0",
      "write 1 15",
      "end 1",
    ]);
    expect(chunks).toEqual({ 0: 65536, 1: 15 });
  });

  it("hands the sink blocks that own their bytes (not views into the message buffer)", async () => {
    const { fs, peer } = rig();
    const seen: Uint8Array[] = [];
    const job = fs.download("/x", { write: (_n, d) => void seen.push(d) });
    const shared = new Uint8Array([0, 0, 0, 7, 8, 9, 0, 0]);
    peer({
      case: "block",
      value: create(FileTransferBlockSchema, {
        id: job.id,
        fileNum: 0,
        data: shared.subarray(3, 6),
      }),
    });
    await flush();
    expect([...seen[0]!]).toEqual([7, 8, 9]);
    expect(seen[0]!.byteOffset).toBe(0);
    expect(seen[0]!.buffer.byteLength).toBe(3);
  });

  it("a peer error rejects the job with its text and file number", async () => {
    const { fs, peer } = rig();
    const job = fs.download("/x", { write: () => {} });
    peer({
      case: "error",
      value: create(FileTransferErrorSchema, {
        id: job.id,
        error: "Permission denied",
        fileNum: 3,
      }),
    });
    await expect(job.done).rejects.toMatchObject({
      kind: "remote",
      message: "Permission denied",
      fileNum: 3,
    });
  });

  it("cancel sends FileAction.cancel, rejects as cancelled, and ignores later blocks", async () => {
    const { fs, peer, actions } = rig();
    let writes = 0;
    const job = fs.download("/x", { write: () => void writes++ });
    job.cancel();
    expect(actions().at(-1)).toMatchObject({
      case: "cancel",
      value: { id: job.id },
    });
    await expect(job.done).rejects.toBeInstanceOf(FileJobError);
    peer({
      case: "block",
      value: create(FileTransferBlockSchema, {
        id: job.id,
        fileNum: 0,
        data: new Uint8Array(5),
      }),
    });
    await flush();
    expect(writes).toBe(0);
  });

  it("cancel rejects only once the peer echoes the barrier sent after it; a late done does not complete it", async () => {
    const sent: Message[] = [];
    const fs = new FileSession({ send: (m) => sent.push(m) });
    const job = fs.download("/x", { write: () => {} });
    let outcome = "pending";
    job.done.then(
      () => (outcome = "resolved"),
      (e) => (outcome = `rejected ${e.kind}`),
    );
    job.cancel();
    expect(sent.map((m) => m.union.case)).toEqual([
      "fileAction",
      "fileAction",
      "testDelay",
    ]);
    await flush_();
    expect(outcome).toBe("pending"); // the peer may not have the cancel yet
    const peerSays = (message: Message) =>
      fs.onEvent({ type: "message", message } as SessionEvent);
    peerSays(
      create(MessageSchema, {
        union: {
          case: "fileResponse",
          value: create(FileResponseSchema, {
            union: {
              case: "done",
              value: create(FileTransferDoneSchema, { id: job.id }),
            },
          }),
        },
      }),
    );
    await flush_();
    expect(outcome).toBe("pending");
    const probe = sent[2]!;
    // someone else's echo (another time) does not count
    peerSays(
      create(MessageSchema, {
        union: {
          case: "testDelay",
          value: create(TestDelaySchema, { time: 1n, fromClient: true }),
        },
      }),
    );
    await flush_();
    expect(outcome).toBe("pending");
    peerSays(probe);
    await flush_();
    expect(outcome).toBe("rejected cancelled");
  });

  it("a failing sink stops the job and cancels it on the peer", async () => {
    const { fs, peer, actions } = rig();
    const job = fs.download("/x", {
      write: () => {
        throw new Error("disk full");
      },
    });
    peer({
      case: "block",
      value: create(FileTransferBlockSchema, {
        id: job.id,
        fileNum: 0,
        data: new Uint8Array(5),
      }),
    });
    await expect(job.done).rejects.toThrow("disk full");
    expect(actions().at(-1)).toMatchObject({ case: "cancel" });
  });

  it("the session closing fails pending jobs and listings", async () => {
    const { fs } = rig();
    const job = fs.download("/x", { write: () => {} });
    const list = fs.listDir("/y");
    fs.onEvent({
      type: "closed",
      closed: { kind: "transport", message: "gone" },
    });
    await expect(job.done).rejects.toMatchObject({ kind: "closed" });
    await expect(list).rejects.toMatchObject({ kind: "closed" });
  });
});

describe("FileSession.upload", () => {
  it("sends receive, every block in order with backpressure, done, and completes on the peer's done", async () => {
    const { fs, peer, actions, responses, drains } = rig();
    const size = 2 * FILE_BLOCK_SIZE + 10;
    const reads: [number, number][] = [];
    const job = fs.upload("/dest", [
      {
        name: "a.bin",
        size,
        modifiedMs: 1_700_000_000_000,
        read: async (o, l) => (reads.push([o, l]), new Uint8Array(l).fill(1)),
      },
      {
        name: "sub/b.txt",
        size: 3,
        read: async () => new TextEncoder().encode("abc"),
      },
    ]);
    const recv = actions()[0]!;
    expect(recv.case).toBe("receive");
    expect(recv.value).toMatchObject({
      id: job.id,
      path: "/dest",
      fileNum: 0,
      totalSize: BigInt(size + 3),
    });
    const files = (
      recv.value as {
        files: { name: string; size: bigint; modifiedTime: bigint }[];
      }
    ).files;
    expect(files.map((f) => [f.name, f.size])).toEqual([
      ["a.bin", BigInt(size)],
      ["sub/b.txt", 3n],
    ]);
    expect(files[0]!.modifiedTime).toBe(1_700_000_000n);
    for (let i = 0; i < 10; i++) await flush();
    const r = responses();
    expect(
      r.map((u) => `${u.case}:${(u.value as { fileNum: number }).fileNum}`),
    ).toEqual(["block:0", "block:0", "block:0", "block:1", "done:1"]);
    expect(reads).toEqual([
      [0, FILE_BLOCK_SIZE],
      [FILE_BLOCK_SIZE, FILE_BLOCK_SIZE],
      [2 * FILE_BLOCK_SIZE, 10],
    ]);
    expect(drains()).toBe(4);
    let finished = false;
    void job.done.then(() => (finished = true));
    await flush();
    expect(finished).toBe(false); // not before the peer confirms
    peer({
      case: "done",
      value: create(FileTransferDoneSchema, { id: job.id }),
    });
    await job.done;
  });

  it("cancel mid-upload stops sending and sends FileAction.cancel", async () => {
    const { fs, actions, responses } = rig();
    let calls = 0;
    const job = fs.upload("/dest", [
      {
        name: "big",
        size: 10 * FILE_BLOCK_SIZE,
        read: async (_o, l) => (
          ++calls === 2 && job.cancel(),
          new Uint8Array(l)
        ),
      },
    ]);
    await expect(job.done).rejects.toMatchObject({ kind: "cancelled" });
    for (let i = 0; i < 10; i++) await flush();
    expect(actions().at(-1)).toMatchObject({
      case: "cancel",
      value: { id: job.id },
    });
    expect(responses().filter((u) => u.case === "done")).toHaveLength(0);
    expect(responses().length).toBeLessThanOrEqual(2);
  });
});
