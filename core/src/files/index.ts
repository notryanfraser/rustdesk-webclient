// File transfer over a file-transfer session. Pure TS (no DOM): sinks and sources are
// callbacks, so the browser decides where bytes come from and go to (app: File objects, the File
// System Access API, OPFS).
//
// Upstream (rustdesk 1.5.3 src/server/connection.rs, libs/base/src/fs.rs; every step below was observed live against a 1.5.3 peer):
// * Only a session logged in with LoginRequest.file_transfer handles FileAction (3516-3525), so
// this needs its own connection: connectSession({ fileTransfer }) (ConnType FILE_TRANSFER).
// The peer answers the login with peer_info (no displays) and a listing of the login dir.
// * List: FileAction.read_dir{path} -> FileResponse.dir{id: 0, path, entries}.
// * Download: FileAction.send{id, path} -> FileResponse.dir{id, path, entries: every file of the
// job, recursively, names relative to path ("" for a single file)} (process_new_read_job), then
// per file FileResponse.block{id, file_num, data, compressed} of up to 128 KiB (zstd when that
// is smaller and the file type is not already compressed, TransferJob::read 1035-1120), an
// EMPTY block ending each file, then FileResponse.done{id, file_num: file count}, or
// FileResponse.error{id, file_num, error}. The peer sends one block per millisecond
// (file_timer MILLI1); nothing paces it but TCP, so a sink must keep up.
// * Upload: FileAction.receive{id, path: destination dir, files, file_num: 0, total_size}, then
// FileResponse.block{id, file_num, data} per file in order (uncompressed is accepted), then
// FileResponse.done{id, file_num}. The peer writes "<name>.download" and renames it on done,
// then answers FileResponse.done{id}. We wait for that answer.
// * Cancel: FileAction.cancel{id}: stops a download job, and for an upload deletes the partial
// "<name>.download" of the file in progress (ui_cm_interface.rs CancelWrite, fs.rs
// remove_download_file 808-830).
// * We send no LoginRequest.version, so the peer runs without overwrite detection (fs.rs
// can_enable_overwrite_detection: version >= 1.1.10): no digest / send_confirm round trips,
// an existing file is overwritten, and there is no resume.
import { create } from "@bufbuild/protobuf";
import {
  FileActionSchema,
  FileDirCreateSchema,
  FileEntrySchema,
  FileRemoveDirSchema,
  FileRemoveFileSchema,
  FileRenameSchema,
  FileResponseSchema,
  FileTransferBlockSchema,
  FileTransferCancelSchema,
  FileTransferDoneSchema,
  FileTransferReceiveRequestSchema,
  FileTransferSendRequestSchema,
  FileType,
  MessageSchema,
  ReadDirSchema,
  TestDelaySchema,
} from "../gen/message_pb.js";
import type {
  FileAction,
  FileDirectory,
  FileEntry,
  FileResponse,
  Message,
} from "../gen/message_pb.js";
import { zstdDecompress } from "../clipboard/index.js";
import type { SessionEvent } from "../session/session.js";

/** Block size the peer sends and we send (TransferJob::read BUF_SIZE). */
export const FILE_BLOCK_SIZE = 128 * 1024;

/** How long a cancel waits for the peer's echo before reporting anyway (see abort). */
const BARRIER_TIMEOUT_MS = 10_000;

/** What FileSession needs from a Session (a file-transfer one). */
export interface FileSessionLike {
  send(msg: Message): void;
  drained?(): Promise<void>;
}

export class FileJobError extends Error {
  constructor(
    message: string,
    /** "remote": the peer reported it; "cancelled"; "closed": the session ended. */
    readonly kind: "remote" | "cancelled" | "closed",
    readonly fileNum?: number,
  ) {
    super(message);
    this.name = "FileJobError";
  }
}

export interface TransferProgress {
  /** Files of the job (download: as the peer listed them; upload: as given). */
  files: FileEntry[];
  /** Index of the file being transferred. */
  fileNum: number;
  /** Payload bytes moved so far (after decompression). */
  bytes: number;
  totalBytes: number;
}

/** Receives a download. Calls are made in order and awaited one at a time. */
export interface DownloadSink {
  /** The peer's file list for the job (before any data). */
  begin?(files: FileEntry[]): void | Promise<void>;
  /** A chunk of file `fileNum`. */
  write(fileNum: number, data: Uint8Array): void | Promise<void>;
  /** File `fileNum` is complete. */
  endFile?(fileNum: number): void | Promise<void>;
}

/** One file to upload: its name under the destination dir (may contain "/"), size, and data. */
export interface UploadSource {
  name: string;
  size: number;
  /** Modification time, ms since epoch (the peer sets it on the written file). */
  modifiedMs?: number;
  /** Bytes [offset, offset + length) of the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface TransferJob {
  readonly id: number;
  /** Resolves when the transfer completed (and, for uploads, the peer confirmed it). */
  readonly done: Promise<void>;
  cancel(): void;
}

type Pending = {
  progress: TransferProgress;
  onProgress?: (p: TransferProgress) => void;
  resolve: () => void;
  reject: (e: Error) => void;
  /** Download only: serialized sink writes. */
  chain: Promise<void>;
  sink?: DownloadSink;
  settled: boolean;
  /** Cancelled or failed locally: nothing more is sent or written; settles once flushed. */
  stopped: boolean;
};

export class FileSession {
  private nextId = 1;
  private readonly jobs = new Map<number, Pending>();
  private readonly listings: Array<{
    path: string;
    resolve: (d: FileDirectory) => void;
    reject: (e: Error) => void;
  }> = [];
  private closed = false;
  private nextBarrier = 0;
  private readonly barriers = new Map<bigint, () => void>();

  constructor(private readonly session: FileSessionLike) {}

  /** Feed every session event (connectSession's onEvent, or Session.on). */
  readonly onEvent = (e: SessionEvent): void => {
    if (e.type === "closed")
      return this.fail(new FileJobError("session closed", "closed"));
    const u = e.message.union;
    if (u.case === "fileResponse") this.onResponse(u.value);
    else if (u.case === "testDelay" && u.value.fromClient)
      this.barriers.get(u.value.time)?.();
  };

  /**
   * List a directory on the peer. "" is its home folder, answered with the real path; on Windows
   * "/" is the list of drives (fs.rs read_dir), not a folder you can write into.
   */
  listDir(path: string, includeHidden = false): Promise<FileDirectory> {
    return new Promise((resolve, reject) => {
      if (this.closed)
        return reject(new FileJobError("session closed", "closed"));
      this.listings.push({ path, resolve, reject });
      this.action({
        case: "readDir",
        value: create(ReadDirSchema, { path, includeHidden }),
      });
    });
  }

  /** Download a file or a whole directory (recursively) from the peer into `sink`. */
  download(
    path: string,
    sink: DownloadSink,
    opts: {
      includeHidden?: boolean;
      onProgress?: (p: TransferProgress) => void;
    } = {},
  ): TransferJob {
    const id = this.nextId++;
    const done = this.track(
      id,
      { files: [], fileNum: 0, bytes: 0, totalBytes: 0 },
      opts.onProgress,
      sink,
    );
    this.action({
      case: "send",
      value: create(FileTransferSendRequestSchema, {
        id,
        path,
        includeHidden: opts.includeHidden ?? false,
        fileNum: 0,
      }),
    });
    return { id, done, cancel: () => this.cancel(id) };
  }

  /** Upload files into directory `destDir` on the peer (created as needed). */
  upload(
    destDir: string,
    sources: UploadSource[],
    opts: { onProgress?: (p: TransferProgress) => void } = {},
  ): TransferJob {
    const id = this.nextId++;
    const files = sources.map((s) =>
      create(FileEntrySchema, {
        entryType: FileType.File,
        name: s.name,
        size: BigInt(s.size),
        modifiedTime: BigInt(Math.floor((s.modifiedMs ?? Date.now()) / 1000)),
      }),
    );
    const totalBytes = sources.reduce((n, s) => n + s.size, 0);
    const progress = { files, fileNum: 0, bytes: 0, totalBytes };
    const done = this.track(id, progress, opts.onProgress);
    this.action({
      case: "receive",
      value: create(FileTransferReceiveRequestSchema, {
        id,
        path: destDir,
        files,
        fileNum: 0,
        totalSize: BigInt(totalBytes),
      }),
    });
    void this.pump(id, sources).catch((e) => this.settle(id, e));
    return { id, done, cancel: () => this.cancel(id) };
  }

  mkdir(path: string): void {
    this.action({
      case: "create",
      value: create(FileDirCreateSchema, { id: this.nextId++, path }),
    });
  }

  removeFile(path: string): void {
    this.action({
      case: "removeFile",
      value: create(FileRemoveFileSchema, { id: this.nextId++, path }),
    });
  }

  removeDir(path: string, recursive = false): void {
    this.action({
      case: "removeDir",
      value: create(FileRemoveDirSchema, {
        id: this.nextId++,
        path,
        recursive,
      }),
    });
  }

  rename(path: string, newName: string): void {
    this.action({
      case: "rename",
      value: create(FileRenameSchema, { id: this.nextId++, path, newName }),
    });
  }

  private cancel(id: number): void {
    this.abort(id, new FileJobError("cancelled", "cancelled"));
  }

  /**
   * Stop job `id` on the peer (FileAction.cancel) and fail it with `error` once the peer has the
   * cancel. A connection that drops before the cancel arrives leaves the partial
   * "<name>.download" on the peer, and the cancel travels behind megabytes of upload blocks
   * (browser send buffer, then TCP, proxy and relay buffers: an emptied send buffer was not
   * enough, observed live). The peer does not answer a cancel, but it echoes a client TestDelay
   * in order (connection.rs 3132-3136; allowed on file-transfer sessions as housekeeping,
   * 5949/6015), so `done` rejects when that echo returns. Until then the job is stopped:
   * nothing more is sent or written.
   */
  private abort(id: number, error: Error): void {
    const job = this.jobs.get(id);
    if (!this.live(job)) return;
    job.stopped = true;
    if (this.closed) return this.settle(id, error);
    this.action({
      case: "cancel",
      value: create(FileTransferCancelSchema, { id }),
    });
    void this.barrier().then(() => this.settle(id, error));
  }

  /** Resolves once the peer has received everything sent so far (or after BARRIER_TIMEOUT_MS). */
  private barrier(): Promise<void> {
    const time = BigInt(Date.now()) * 1000n + BigInt(this.nextBarrier++ % 1000);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.barriers.delete(time);
        resolve();
      }, BARRIER_TIMEOUT_MS);
      this.barriers.set(time, () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        this.send(
          create(MessageSchema, {
            union: {
              case: "testDelay",
              value: create(TestDelaySchema, { time, fromClient: true }),
            },
          }),
        );
      } catch {
        this.barriers.delete(time);
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private live(job: Pending | undefined): job is Pending {
    return !!job && !job.settled && !job.stopped;
  }

  private track(
    id: number,
    progress: TransferProgress,
    onProgress?: (p: TransferProgress) => void,
    sink?: DownloadSink,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.jobs.set(id, {
        progress,
        onProgress,
        resolve,
        reject,
        chain: Promise.resolve(),
        sink,
        settled: false,
        stopped: false,
      });
    });
  }

  /** Send every file's blocks in order, waiting on socket backpressure, then done. */
  private async pump(id: number, sources: UploadSource[]): Promise<void> {
    for (const [fileNum, src] of sources.entries()) {
      const job = this.jobs.get(id);
      if (!this.live(job)) return;
      job.progress.fileNum = fileNum;
      for (let offset = 0; offset < src.size;) {
        if (!this.live(this.jobs.get(id))) return;
        const data = await src.read(
          offset,
          Math.min(FILE_BLOCK_SIZE, src.size - offset),
        );
        if (data.length === 0)
          throw new Error(`${src.name}: read returned no data at ${offset}`);
        this.response({
          case: "block",
          value: create(FileTransferBlockSchema, {
            id,
            fileNum,
            data,
            compressed: false,
          }),
        });
        offset += data.length;
        job.progress.bytes += data.length;
        job.onProgress?.(job.progress);
        await this.session.drained?.();
      }
    }
    if (!this.live(this.jobs.get(id))) return;
    this.response({
      case: "done",
      value: create(FileTransferDoneSchema, {
        id,
        fileNum: sources.length - 1,
      }),
    });
    // The job completes when the peer confirms with its own done (onResponse).
  }

  private onResponse(r: FileResponse): void {
    const u = r.union;
    switch (u.case) {
      case "dir": {
        const d = u.value;
        if (d.id !== 0) {
          const job = this.jobs.get(d.id);
          if (!this.live(job) || !job.sink) return;
          job.progress.files = d.entries;
          job.progress.totalBytes = d.entries.reduce(
            (n, f) => n + Number(f.size),
            0,
          );
          this.serial(job, () => job.sink!.begin?.(d.entries));
          return;
        }
        // "" asks for the peer's home folder, and the answer carries the real path ("/config",
        // "C:\\Users\\me": ui_cm_interface.rs read_dir 1649-1660), so a request for "" takes a
        // listing that no other pending request asked for by name.
        let i = this.listings.findIndex((l) => l.path === d.path);
        if (i < 0) i = this.listings.findIndex((l) => l.path === "");
        // The peer also lists the login dir unasked; an unmatched listing is not an error.
        if (i >= 0) this.listings.splice(i, 1)[0]!.resolve(d);
        return;
      }
      case "block": {
        const b = u.value;
        const job = this.jobs.get(b.id);
        if (!this.live(job) || !job.sink) return;
        let data: Uint8Array;
        try {
          // zstdDecompress bounds its output; a 128 KiB block never decodes to more than that.
          // Uncompressed data is copied: b.data is a view into the decrypted message's buffer
          // (tweetnacl's 32 zero bytes, then the protobuf framing), and WebKit's Blob takes the
          // whole buffer of a view, not its range: Safari's in-memory downloads came out 44-47
          // bytes per block too long (a GIF that would not open).
          data = b.compressed
            ? zstdDecompress(b.data, 4 * FILE_BLOCK_SIZE)
            : b.data.slice();
        } catch (e) {
          this.abort(
            b.id,
            new FileJobError(
              `bad block: ${(e as Error).message}`,
              "remote",
              b.fileNum,
            ),
          );
          return;
        }
        const fileNum = b.fileNum;
        job.progress.fileNum = fileNum;
        if (data.length === 0) {
          this.serial(job, () => job.sink!.endFile?.(fileNum));
        } else {
          job.progress.bytes += data.length;
          this.serial(job, () => job.sink!.write(fileNum, data));
        }
        job.onProgress?.(job.progress);
        return;
      }
      case "done": {
        const job = this.jobs.get(u.value.id);
        if (!this.live(job)) return;
        // Downloads: complete once every queued sink write has finished.
        void job.chain.then(() => {
          if (this.live(job)) this.settle(u.value.id);
        });
        return;
      }
      case "error": {
        const e = u.value;
        if (e.id === 0) {
          // A listing failed (e.g. no such dir); the peer does not say which path.
          this.listings.shift()?.reject(new FileJobError(e.error, "remote"));
          return;
        }
        if (this.live(this.jobs.get(e.id)))
          this.settle(e.id, new FileJobError(e.error, "remote", e.fileNum));
        return;
      }
    }
  }

  private serial(job: Pending, step: () => void | Promise<void>): void {
    job.chain = job.chain.then(step).catch((e: unknown) => {
      // A failing sink (disk full, user revoked access): stop the peer and report it.
      const id = [...this.jobs].find(([, j]) => j === job)?.[0];
      if (id !== undefined) {
        this.abort(id, e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private settle(id: number, error?: Error): void {
    const job = this.jobs.get(id);
    if (!job || job.settled) return;
    job.settled = true;
    this.jobs.delete(id);
    if (error) job.reject(error);
    else job.resolve();
  }

  private fail(e: Error): void {
    this.closed = true;
    for (const release of [...this.barriers.values()]) release();
    for (const id of [...this.jobs.keys()]) this.settle(id, e);
    for (const l of this.listings.splice(0)) l.reject(e);
  }

  private action(union: FileAction["union"]): void {
    this.send(
      create(MessageSchema, {
        union: {
          case: "fileAction",
          value: create(FileActionSchema, { union }),
        },
      }),
    );
  }

  private response(union: FileResponse["union"]): void {
    this.send(
      create(MessageSchema, {
        union: {
          case: "fileResponse",
          value: create(FileResponseSchema, { union }),
        },
      }),
    );
  }

  private send(m: Message): void {
    if (this.closed) throw new FileJobError("session closed", "closed");
    this.session.send(m);
  }
}
