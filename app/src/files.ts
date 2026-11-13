// File-transfer plumbing for the Files panel: the file-transfer session, where downloads go
// , and browser File objects as upload sources.
import {
  FileSession,
  connectSession,
  type DownloadSink,
  type FileEntry,
  type Session,
  type UploadSource,
} from "@rustdesk-web/core";
import type { AppConfig } from "./config";

/** A peer refuses file actions on a remote-desktop session: file transfer is its own login. */
export async function openFileSession(
  config: AppConfig,
  peerId: string,
  password: string,
): Promise<{ session: Session; files: FileSession }> {
  let files: FileSession | undefined;
  const { session } = await connectSession({
    idServer: config.idServer,
    serverKey: config.key,
    peerId,
    password,
    pageIsHttps: config.wss,
    fileTransfer: { dir: "" },
    onEvent: (e) => files?.onEvent(e),
  });
  files = new FileSession(session);
  return { session, files };
}

/** Path helpers that follow the peer's separator ("C:\\Users" on Windows, "/home" elsewhere). */
export const separatorOf = (path: string) =>
  /^[A-Za-z]:|\\/.test(path) ? "\\" : "/";
export function joinPath(dir: string, name: string): string {
  // Windows' drive list ("/", fs.rs read_dir) holds drives named "C:": the folder is "C:\\".
  if (dir === "/" && /^[A-Za-z]:$/.test(name)) return `${name}\\`;
  const sep = separatorOf(dir || name);
  if (!dir) return name;
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}
export function parentPath(path: string): string {
  // Up from a Windows drive root is the drive list.
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return "/";
  const sep = separatorOf(path);
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  const i = trimmed.lastIndexOf(sep);
  if (i < 0) return "";
  if (i === 0) return sep;
  if (sep === "\\" && /^[A-Za-z]:$/.test(trimmed.slice(0, i)))
    return trimmed.slice(0, i + 1);
  return trimmed.slice(0, i);
}
export const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? path;

export interface DownloadTarget {
  /** "fsa": the file/folder the user picked; "opfs": saved when complete; "memory": small files only. */
  kind: "fsa" | "opfs" | "memory";
  sink: DownloadSink;
  /** After the job's done: close files; for opfs/memory hand the file to the browser. */
  finish(): Promise<void>;
  /** After a failure or cancel: drop partial data. */
  abort(): Promise<void>;
}

export const canPickFolder = () =>
  typeof window.showDirectoryPicker === "function";
const MEMORY_LIMIT = 512 * 1024 * 1024;
const OPFS_DIR = "rustdesk-web-downloads";

declare global {
  interface Window {
    showSaveFilePicker?: (o?: {
      suggestedName?: string;
    }) => Promise<FileSystemFileHandle>;
    showDirectoryPicker?: (o?: {
      mode?: "read" | "readwrite";
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

/**
 * Where a download goes. MUST be called from the click that started it: the pickers need
 * a user gesture. Throws (AbortError) if the user cancels the picker; Error for no room.
 */
export async function pickDownloadTarget(
  name: string,
  isDir: boolean,
  totalBytes: number,
): Promise<DownloadTarget> {
  if (isDir) {
    if (!window.showDirectoryPicker)
      throw new Error(
        "Downloading a whole folder needs a Chromium-based browser here; download its files one by one.",
      );
    return folderTarget(
      await window.showDirectoryPicker({ mode: "readwrite" }),
    );
  }
  if (window.showSaveFilePicker)
    return fileTarget(await window.showSaveFilePicker({ suggestedName: name }));
  if (typeof navigator.storage?.getDirectory === "function") {
    const est = await navigator.storage.estimate().catch(() => undefined);
    if (est?.quota !== undefined && totalBytes > est.quota - (est.usage ?? 0))
      throw new Error(
        `Not enough browser storage for ${formatBytes(totalBytes)} (${formatBytes(est.quota - (est.usage ?? 0))} free).`,
      );
    try {
      return await opfsTarget(name);
    } catch {
      // OPFS without writable streams (Safari): fall through to memory
    }
  }
  if (totalBytes > MEMORY_LIMIT)
    throw new Error(
      `This browser can only download files up to ${formatBytes(MEMORY_LIMIT)}.`,
    );
  return memoryTarget(name);
}

function fileTarget(handle: FileSystemFileHandle): DownloadTarget {
  let w: FileSystemWritableFileStream | undefined;
  return {
    kind: "fsa",
    sink: {
      write: async (_n, data) => {
        w ??= await handle.createWritable();
        await w.write(data as Uint8Array<ArrayBuffer>);
      },
    },
    finish: async () => {
      w ??= await handle.createWritable(); // an empty file
      await w.close();
    },
    abort: async () => {
      await w?.abort().catch(() => {});
    },
  };
}

function folderTarget(root: FileSystemDirectoryHandle): DownloadTarget {
  let files: FileEntry[] = [];
  let current:
    | {
        n: number;
        w: FileSystemWritableFileStream;
        dir: FileSystemDirectoryHandle;
        name: string;
      }
    | undefined;
  const open = async (n: number) => {
    const parts = (files[n]?.name || `file-${n}`)
      .split(/[\\/]/)
      .filter(Boolean);
    // Names come from the peer: a hostile one could send "../x". File System Access refuses such
    // names too, but do not rely on it.
    if (parts.some((p) => p === "." || p === ".."))
      throw new Error(`unsafe file name from the remote: ${files[n]?.name}`);
    let dir = root;
    for (const p of parts.slice(0, -1))
      dir = await dir.getDirectoryHandle(p, { create: true });
    const name = parts.at(-1)!;
    const w = await (
      await dir.getFileHandle(name, { create: true })
    ).createWritable();
    current = { n, w, dir, name };
  };
  return {
    kind: "fsa",
    sink: {
      begin: (f) => void (files = f),
      write: async (n, data) => {
        if (current?.n !== n) await open(n);
        await current!.w.write(data as Uint8Array<ArrayBuffer>);
      },
      endFile: async (n) => {
        if (current?.n !== n) await open(n); // an empty file
        await current!.w.close();
        current = undefined;
      },
    },
    finish: async () => {},
    abort: async () => {
      if (!current) return;
      await current.w.abort().catch(() => {});
      await current.dir.removeEntry(current.name).catch(() => {});
    },
  };
}

async function opfsTarget(name: string): Promise<DownloadTarget> {
  const dir = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(OPFS_DIR, { create: true });
  const temp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const handle = await dir.getFileHandle(temp, { create: true });
  const w = await handle.createWritable();
  return {
    kind: "opfs",
    sink: { write: (_n, data) => w.write(data as Uint8Array<ArrayBuffer>) },
    finish: async () => {
      await w.close();
      saveAs(await handle.getFile(), name);
      // The download reads the disk-backed File; give it time before deleting the temp copy.
      setTimeout(() => void dir.removeEntry(temp).catch(() => {}), 120_000);
    },
    abort: async () => {
      await w.abort().catch(() => {});
      await dir.removeEntry(temp).catch(() => {});
    },
  };
}

function memoryTarget(name: string): DownloadTarget {
  let parts: Uint8Array[] = [];
  return {
    kind: "memory",
    sink: { write: (_n, data) => void parts.push(data) },
    finish: async () => saveAs(new Blob(parts as BlobPart[]), name),
    abort: async () => void (parts = []),
  };
}

function saveAs(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: name,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

/** Leftovers of downloads a closed or crashed tab never finished. */
export async function cleanTemporaryDownloads(): Promise<void> {
  try {
    await (
      await navigator.storage.getDirectory()
    ).removeEntry(OPFS_DIR, { recursive: true });
  } catch {
    // none, or no OPFS
  }
}

/** Browser File (from a picker or a drop) as an upload source; folder uploads keep their paths. */
export function fileSource(file: File): UploadSource {
  return {
    name: file.webkitRelativePath || file.name,
    size: file.size,
    modifiedMs: file.lastModified,
    read: async (offset, length) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
