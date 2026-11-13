// Files panel: browse the remote machine's files, download, upload (pickers or drag
// and drop), new folder, delete; transfers with progress and cancel. Opens its own file-transfer
// session on first use (a peer only does file actions on one), with the session's credentials.
// SessionView keeps it mounted once opened and only hides it, so transfers (and the login) outlive
// the panel being closed; the session ends with the SessionView.
import { useEffect, useRef, useState } from "preact/hooks";
import {
  FileType,
  describeError,
  type FileEntry,
  type FileSession,
  type Session,
  type TransferJob,
} from "@rustdesk-web/core";
import type { AppConfig } from "./config";
import { ArrowIcon, FilesIcon, RefreshIcon } from "./icons";
import {
  baseName,
  canPickFolder,
  fileSource,
  formatBytes,
  joinPath,
  openFileSession,
  parentPath,
  pickDownloadTarget,
} from "./files";

const isDir = (e: FileEntry) =>
  e.entryType === FileType.Dir ||
  e.entryType === FileType.DirLink ||
  e.entryType === FileType.DirDrive;

interface Transfer {
  key: number;
  label: string;
  up: boolean;
  bytes: number;
  total: number;
  state: "running" | "done" | "failed" | "cancelled";
  message?: string;
  job?: TransferJob;
}

export interface TransferSummary {
  running: number;
  /** 0 to 100 over everything running; undefined while no size is known. */
  percent: number | undefined;
}

let transferKeys = 0;

export function FilesPanel(props: {
  config: AppConfig;
  peerId: string;
  password: string;
  /** Running transfers and their overall progress, for the bar and the disconnect check. */
  onTransfers: (t: TransferSummary) => void;
}) {
  const conn = useRef<{ session: Session; files: FileSession }>();
  const [status, setStatus] = useState<"connecting" | "ready" | "error">(
    "connecting",
  );
  const [error, setError] = useState("");
  const [path, setPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [naming, setNaming] = useState<string>();
  const nameInput = useRef<HTMLInputElement>(null);
  const newFolderBtn = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const list = async (p: string) => {
    const c = conn.current;
    if (!c) return;
    setError("");
    try {
      const d = await c.files.listDir(p);
      const sorted = [...d.entries].sort(
        (a, b) =>
          Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name),
      );
      setPath(d.path);
      setPathInput(d.path);
      setEntries(sorted);
      setSelected(new Set());
      setConfirmDelete(false);
    } catch (e) {
      setError(`Cannot open ${p || "/"}: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    let closed = false;
    openFileSession(props.config, props.peerId, props.password).then(
      async (c) => {
        if (closed) return void c.session.close();
        conn.current = c;
        void c.session.closed.then((why) => {
          if (why.kind !== "local") {
            setStatus("error");
            setError(`File session ended: ${why.message}`);
          }
        });
        setStatus("ready");
        // The peer's home directory: what it lists for the login dir "" (it sends that unasked).
        await list("");
      },
      (e) => {
        setStatus("error");
        setError(describeError(e).userMessage);
      },
    );
    return () => {
      closed = true;
      // Cancel what is running and close only once the cancels are out: a connection dropped
      // mid-upload leaves the partial "<name>.download" on the peer.
      const running = transfersRef.current.filter(
        (t) => t.state === "running" && t.job,
      );
      for (const t of running) t.job!.cancel();
      const c = conn.current;
      void Promise.allSettled(running.map((t) => t.job!.done)).then(() =>
        c?.session.close(),
      );
    };
  }, []);

  // SessionView guards leaving the page while the session is live, and shows what runs.
  const report = useRef(props.onTransfers);
  report.current = props.onTransfers;
  const last = useRef("");
  useEffect(() => {
    const running = transfers.filter((t) => t.state === "running");
    const total = running.reduce((n, t) => n + t.total, 0);
    const bytes = running.reduce((n, t) => n + Math.min(t.bytes, t.total), 0);
    const percent = total > 0 ? Math.floor((bytes / total) * 100) : undefined;
    const sig = `${running.length}/${percent}`;
    if (sig === last.current) return;
    last.current = sig;
    report.current({ running: running.length, percent });
  }, [transfers]);

  const transfersRef = useRef<Transfer[]>([]);
  transfersRef.current = transfers;
  const update = (key: number, p: Partial<Transfer>) =>
    setTransfers((ts) => ts.map((t) => (t.key === key ? { ...t, ...p } : t)));
  const add = (t: Omit<Transfer, "key" | "state" | "bytes">) => {
    const key = ++transferKeys;
    setTransfers((ts) => [{ ...t, key, state: "running", bytes: 0 }, ...ts]);
    return key;
  };

  const download = async (e: FileEntry) => {
    const c = conn.current!;
    const remote = joinPath(path, e.name);
    let target;
    try {
      // Pick first: the save/folder pickers need this click's user gesture.
      target = await pickDownloadTarget(e.name, isDir(e), Number(e.size));
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        setError((err as Error).message);
      return;
    }
    const key = add({ label: e.name, up: false, total: Number(e.size) });
    const job = c.files.download(remote, target.sink, {
      onProgress: (p) => update(key, { bytes: p.bytes, total: p.totalBytes }),
    });
    update(key, { job });
    try {
      await job.done;
      await target.finish();
      update(key, {
        state: "done",
        message: target.kind === "opfs" ? "saved to your downloads" : undefined,
      });
    } catch (err) {
      await target.abort();
      const cancelled = (err as { kind?: string }).kind === "cancelled";
      // Private windows keep browser storage in memory: far less room than estimate() reports.
      const quota = (err as Error).name === "QuotaExceededError";
      update(key, {
        state: cancelled ? "cancelled" : "failed",
        message: cancelled
          ? undefined
          : quota
            ? "browser storage is full (in a private window, use a normal one)"
            : (err as Error).message,
      });
    }
  };

  // Uploads need a real folder: not before the first listing arrived (path ""), which the peer
  // would resolve against its own working directory (Windows: "Access is denied", os error 5),
  // and not Windows' drive list ("/"), whose "\\name" is the root of a drive.
  const windowsPeer = /windows/i.test(
    conn.current?.session.peerInfo.platform ?? "",
  );
  const canWrite = path !== "" && !(windowsPeer && path === "/");

  const upload = async (fileList: FileList | File[]) => {
    const files = [...fileList];
    if (!files.length || !conn.current) return;
    if (!canWrite) {
      setError(
        "Open a folder first: files can only be uploaded into a folder.",
      );
      return;
    }
    const total = files.reduce((n, f) => n + f.size, 0);
    const dest = path;
    const label =
      files.length === 1
        ? files[0]!.name
        : `${files.length} files${files[0]!.webkitRelativePath ? ` (${files[0]!.webkitRelativePath.split("/")[0]})` : ""}`;
    const key = add({ label, up: true, total });
    const job = conn.current.files.upload(dest, files.map(fileSource), {
      onProgress: (p) => update(key, { bytes: p.bytes }),
    });
    update(key, { job });
    try {
      await job.done;
      update(key, { state: "done", bytes: total });
      if (dest === path) void list(dest);
    } catch (err) {
      const cancelled = (err as { kind?: string }).kind === "cancelled";
      update(key, {
        state: cancelled ? "cancelled" : "failed",
        message: cancelled ? undefined : (err as Error).message,
      });
    }
  };

  const mkdir = (name: string) => {
    if (!name || !conn.current) return;
    if (/[\\/]/.test(name)) {
      setError("A folder name cannot contain / or \\.");
      return;
    }
    setError("");
    conn.current.files.mkdir(joinPath(path, name));
    setNaming(undefined);
    setTimeout(() => void list(path), 400);
  };
  // The name field takes focus when it opens; the button gets it back when it closes.
  useEffect(() => {
    if (naming !== undefined) nameInput.current?.focus();
  }, [naming === undefined]);
  const stopNaming = () => {
    setNaming(undefined);
    newFolderBtn.current?.focus();
  };

  const remove = () => {
    if (!conn.current) return;
    for (const name of selected) {
      const e = entries.find((x) => x.name === name);
      if (!e) continue;
      const p = joinPath(path, name);
      if (isDir(e)) conn.current.files.removeDir(p, true);
      else conn.current.files.removeFile(p);
    }
    setTimeout(() => void list(path), 500);
  };

  const toggle = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const chosen = entries.filter((e) => selected.has(e.name));
  const downloadable =
    chosen.length === 1 && !(isDir(chosen[0]!) && !canPickFolder());

  return (
    <div
      class={`files${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer?.files.length) void upload(e.dataTransfer.files);
      }}
    >
      {status === "connecting" && <p role="status">Opening a file session…</p>}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {status === "ready" && (
        <>
          <form
            class="pathbar"
            onSubmit={(e) => {
              e.preventDefault();
              void list(pathInput);
            }}
          >
            <button
              type="button"
              class="icon-btn"
              title="Up one folder"
              aria-label="Up one folder"
              onClick={() => void list(parentPath(path))}
            >
              <ArrowIcon dir="up" size={16} />
            </button>
            <input
              aria-label="Remote path"
              value={pathInput}
              onInput={(e) => setPathInput(e.currentTarget.value)}
            />
            <button
              type="button"
              class="icon-btn"
              title="Refresh"
              aria-label="Refresh"
              onClick={() => void list(path)}
            >
              <RefreshIcon size={16} />
            </button>
          </form>
          <div class="actions">
            <button
              type="button"
              class="primary"
              disabled={!canWrite}
              onClick={() => fileInput.current?.click()}
            >
              Upload
            </button>
            <button
              type="button"
              disabled={!canWrite}
              onClick={() => folderInput.current?.click()}
            >
              Upload folder
            </button>
            <button
              ref={newFolderBtn}
              type="button"
              disabled={!canWrite}
              onClick={() => setNaming("")}
            >
              New folder
            </button>
            <span class="spacer" />
            <button
              type="button"
              disabled={!downloadable}
              onClick={() => void download(chosen[0]!)}
            >
              {downloadable ? "Download 1 item" : "Download"}
            </button>
            {confirmDelete ? (
              <>
                <button type="button" class="danger" onClick={remove}>
                  Really delete {chosen.length}?
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={!chosen.length}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => void upload(e.currentTarget.files ?? [])}
            />
            <input
              ref={folderInput}
              type="file"
              hidden
              {...{ webkitdirectory: "" }}
              onChange={(e) => void upload(e.currentTarget.files ?? [])}
            />
          </div>
          {naming !== undefined && (
            <form
              class="newfolder"
              onSubmit={(e) => {
                e.preventDefault();
                mkdir(naming.trim());
              }}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Closes this field, not the panel.
                e.preventDefault();
                e.stopPropagation();
                stopNaming();
              }}
            >
              <input
                ref={nameInput}
                aria-label="New folder name"
                placeholder="Folder name"
                autocomplete="off"
                value={naming}
                onInput={(e) => setNaming(e.currentTarget.value)}
              />
              <button type="submit" class="primary" disabled={!naming.trim()}>
                Create
              </button>
              <button type="button" onClick={stopNaming}>
                Cancel
              </button>
            </form>
          )}
          <ul class="listing" aria-label={`Contents of ${path || "/"}`}>
            {entries.length === 0 && (
              <li class="empty">This folder is empty.</li>
            )}
            {entries.map((e) => (
              <li
                key={e.name}
                class={selected.has(e.name) ? "selected" : undefined}
              >
                <label class="check">
                  <input
                    type="checkbox"
                    aria-label={`Select ${e.name}`}
                    checked={selected.has(e.name)}
                    onChange={() => toggle(e.name)}
                  />
                </label>
                {isDir(e) ? (
                  <button
                    type="button"
                    class="dir"
                    onClick={() => void list(joinPath(path, e.name))}
                  >
                    <FilesIcon size={16} />
                    <span>{e.name}</span>
                  </button>
                ) : (
                  <span class="name" onDblClick={() => void download(e)}>
                    {e.name}
                  </span>
                )}
                <span class="size">
                  {isDir(e) ? "Folder" : formatBytes(Number(e.size))}
                </span>
              </li>
            ))}
          </ul>
          <p class="hint">
            {canWrite
              ? `Drop files here to upload them to ${baseName(path) || path}.`
              : "Open a folder to upload files into it."}
          </p>
        </>
      )}
      {transfers.length > 0 && (
        <section class="transfers" aria-label="Transfers">
          <h3>Transfers keep running while this panel is closed</h3>
          <ul>
            {transfers.map((t) => (
              <li key={t.key} data-state={t.state}>
                <span class="label">
                  <ArrowIcon dir={t.up ? "up" : "down"} size={14} />
                  <span>
                    {t.up ? "Uploading" : "Downloading"} {t.label}
                  </span>
                </span>
                {t.state === "running" && (
                  <button type="button" onClick={() => t.job?.cancel()}>
                    Cancel
                  </button>
                )}
                <progress
                  aria-label={t.label}
                  max={t.total || 1}
                  value={t.state === "done" ? t.total || 1 : t.bytes}
                />
                <span class="detail">
                  {t.state === "running"
                    ? `${formatBytes(t.bytes)} of ${formatBytes(t.total)}`
                    : t.state === "failed"
                      ? `failed: ${t.message}`
                      : t.state === "done"
                        ? `done${t.message ? `, ${t.message}` : ""}`
                        : "cancelled"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
