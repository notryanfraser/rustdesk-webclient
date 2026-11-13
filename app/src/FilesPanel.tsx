// Files panel: browse the remote machine's files, download, upload (pickers or drag
// and drop), new folder, delete; transfers with progress and cancel. Opens its own file-transfer
// session on first use (a peer only does file actions on one), with the session's credentials.
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

let transferKeys = 0;

export function FilesPanel(props: {
  config: AppConfig;
  peerId: string;
  password: string;
  onClose: () => void;
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

  // Leaving the page mid-transfer drops the connection (see above): let the browser ask first.
  const busy = transfers.some((t) => t.state === "running");
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

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

  const mkdir = () => {
    const name = prompt("New folder name");
    if (!name || !conn.current) return;
    conn.current.files.mkdir(joinPath(path, name));
    setTimeout(() => void list(path), 400);
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

  return (
    <aside
      class={`files${dragging ? " dragging" : ""}`}
      aria-label="Files"
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
      <header>
        <h2>Files on {props.peerId}</h2>
        <button type="button" onClick={props.onClose} aria-label="Close files">
          ×
        </button>
      </header>
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
              title="Up"
              aria-label="Up"
              onClick={() => void list(parentPath(path))}
            >
              ↑
            </button>
            <input
              aria-label="Remote path"
              value={pathInput}
              onInput={(e) => setPathInput(e.currentTarget.value)}
            />
            <button
              type="button"
              title="Refresh"
              aria-label="Refresh"
              onClick={() => void list(path)}
            >
              ⟳
            </button>
          </form>
          <div class="actions">
            <button
              type="button"
              disabled={
                chosen.length !== 1 || (isDir(chosen[0]!) && !canPickFolder())
              }
              onClick={() => void download(chosen[0]!)}
            >
              Download
            </button>
            <button
              type="button"
              disabled={!canWrite}
              onClick={() => fileInput.current?.click()}
            >
              Upload files
            </button>
            <button
              type="button"
              disabled={!canWrite}
              onClick={() => folderInput.current?.click()}
            >
              Upload folder
            </button>
            <button type="button" disabled={!canWrite} onClick={mkdir}>
              New folder
            </button>
            {confirmDelete ? (
              <button type="button" class="danger" onClick={remove}>
                Really delete {chosen.length}?
              </button>
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
          <table class="listing" aria-label={`Contents of ${path || "/"}`}>
            <thead>
              <tr>
                <th />
                <th>Name</th>
                <th>Size</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.name}
                  class={selected.has(e.name) ? "selected" : undefined}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${e.name}`}
                      checked={selected.has(e.name)}
                      onChange={() => toggle(e.name)}
                    />
                  </td>
                  <td>
                    {isDir(e) ? (
                      <button
                        type="button"
                        class="dir"
                        onClick={() => void list(joinPath(path, e.name))}
                      >
                        📁 {e.name}
                      </button>
                    ) : (
                      <span onDblClick={() => void download(e)}>{e.name}</span>
                    )}
                  </td>
                  <td>{isDir(e) ? "" : formatBytes(Number(e.size))}</td>
                  <td>
                    {e.modifiedTime
                      ? new Date(Number(e.modifiedTime) * 1000).toLocaleString()
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p class="hint">
            {canWrite
              ? `Drop files here to upload them to ${baseName(path) || path}.`
              : "Open a folder to upload files into it."}
          </p>
        </>
      )}
      {transfers.length > 0 && (
        <section class="transfers" aria-label="Transfers">
          <h3>Transfers</h3>
          <ul>
            {transfers.map((t) => (
              <li key={t.key} data-state={t.state}>
                <span class="label">
                  {t.up ? "↑" : "↓"} {t.label}
                </span>
                <progress
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
                {t.state === "running" && (
                  <button type="button" onClick={() => t.job?.cancel()}>
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
