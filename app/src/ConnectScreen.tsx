// Connect screen: new connection form, saved remotes, and the outcome of the last attempt.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ErrorDescription } from "@rustdesk-web/core";
import {
  forgetAll,
  forgetPeer,
  loadRecent,
  loadRemember,
  renamePeer,
  saveRemember,
  type RecentPeer,
} from "./recent";

/** RustDesk IDs are shown grouped ("123 456 789"); accept spaces and dashes. */
export const normalizeId = (s: string) => s.replace(/[\s-]/g, "");

/** Groups all-digit IDs in threes from the right; IDs with letters or underscores stay as typed. */
export const formatId = (s: string) => {
  const id = normalizeId(s);
  return /^\d+$/.test(id) ? id.replace(/(\d)(?=(\d{3})+$)/g, "$1 ") : s;
};

const coarsePointer = () => matchMedia("(pointer: coarse)").matches;

/** "2 hours ago", "Yesterday", then a short date. */
function lastSeen(at: number, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return rtf.format(-min, "minute");
  if (min < 60 * 12) return rtf.format(-Math.floor(min / 60), "hour");
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return rtf.format(-Math.floor(min / 60), "hour");
  if (days === 1) {
    const s = rtf.format(-1, "day");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(!sameYear && { year: "numeric" }),
  });
}

const label = (p: RecentPeer) => p.name ?? formatId(p.id);

export function ConnectScreen(props: {
  error?: ErrorDescription;
  notice?: string;
  initialPeerId?: string;
  /** Set after a dropped session: the password of that attempt, kept in memory only. */
  reconnect?: { peerId: string; password: string; dropped: boolean };
  onConnect: (peerId: string, password: string) => void;
  /** The user edited a field: the remembered password must go. */
  onForgetPassword: () => void;
  /** The user dismissed the banner. */
  onDismiss: () => void;
}) {
  const [recent, setRecent] = useState<RecentPeer[]>(loadRecent);
  const [remember, setRemember] = useState(loadRemember);
  const [confirmClear, setConfirmClear] = useState(false);
  const [peerId, setPeerId] = useState(() =>
    formatId(props.initialPeerId ?? recent[0]?.id ?? ""),
  );
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [menu, setMenu] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [draft, setDraft] = useState("");
  const pwRef = useRef<HTMLInputElement>(null);
  const idRef = useRef<HTMLInputElement>(null);
  const moreRefs = useRef(new Map<string, HTMLButtonElement>());
  const caret = useRef<number>();
  // Escape unmounts the input, which blurs it; that blur must not save.
  const renameDone = useRef(false);
  const id = normalizeId(peerId);
  const valid = /^[A-Za-z0-9_]{6,}$/.test(id);
  // A soft keyboard popping up on load hides the screen on phones.
  const autoFocus = !coarsePointer();

  // Keeps the caret next to the same digit when grouping rewrites the value.
  useEffect(() => {
    if (caret.current !== undefined)
      idRef.current?.setSelectionRange(caret.current, caret.current);
    caret.current = undefined;
  }, [peerId]);

  // Close the More menu on a press elsewhere.
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element).closest(".peer-menu, .peer-more"))
        setMenu(undefined);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  const submit = (e: Event) => {
    e.preventDefault();
    if (valid) props.onConnect(id, password);
  };

  const onIdInput = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const digitsBefore = el.value
      .slice(0, el.selectionStart ?? el.value.length)
      .replace(/[\s-]/g, "").length;
    const next = formatId(el.value);
    // Position after the same number of non-separator characters.
    let pos = 0;
    for (let n = 0; pos < next.length && n < digitsBefore; pos++)
      if (!/[\s-]/.test(next.charAt(pos))) n++;
    caret.current = pos;
    el.value = next;
    setPeerId(next);
    props.onForgetPassword();
  };

  const closeMenu = (refocus: string) => {
    setMenu(undefined);
    moreRefs.current.get(refocus)?.focus();
  };

  const startRename = (p: RecentPeer) => {
    setMenu(undefined);
    setDraft(p.name ?? "");
    renameDone.current = false;
    setRenaming(p.id);
  };

  const finishRename = (p: RecentPeer, save: boolean) => {
    if (renameDone.current) return;
    renameDone.current = true;
    setRenaming(undefined);
    if (save) setRecent(renamePeer(recent, p.id, draft));
    moreRefs.current.get(p.id)?.focus();
  };

  const onMenuKey = (e: KeyboardEvent, p: RecentPeer) => {
    if (e.key === "Escape") return closeMenu(p.id);
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [
      ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
        "[role=menuitem]",
      ),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  const onRememberChange = (on: boolean) => {
    if (on) {
      saveRemember(true);
      setRemember(true);
    } else if (recent.length) setConfirmClear(true);
    else {
      saveRemember(false);
      setRemember(false);
    }
  };

  const lost = props.reconnect;
  const lostPeer = lost && recent.find((p) => p.id === lost.peerId);
  const lostName = lostPeer ? label(lostPeer) : lost && formatId(lost.peerId);
  const details = props.error && (
    <details>
      <summary>Details</summary>
      <code>
        {props.error.layer}/{props.error.code}: {props.error.detail}
      </code>
    </details>
  );

  return (
    <main class="connect">
      <header class="connect-head">
        <div class="connect-brand">
          <img src="favicon.svg" alt="" width="40" height="40" />
          <h1>Ferry</h1>
        </div>
        <p>Control a RustDesk computer from this browser.</p>
      </header>

      {props.error && lost && (
        <div class="lost" role="alert">
          <p>
            <strong>
              {lost.dropped
                ? `Connection to ${lostName} was lost.`
                : `Could not connect to ${lostName}.`}
            </strong>{" "}
            {props.error.userMessage}
          </p>
          <div class="lost-actions">
            <button
              type="button"
              class="primary"
              onClick={() => props.onConnect(lost.peerId, lost.password)}
            >
              {lost.dropped ? "Reconnect" : "Try again"}
            </button>
            <button type="button" onClick={props.onDismiss}>
              Dismiss
            </button>
          </div>
          {details}
        </div>
      )}
      {props.error && !lost && (
        <div class="error" role="alert">
          <p>{props.error.userMessage}</p>
          {details}
        </div>
      )}
      {!props.error && props.notice && (
        <p class="notice" role="status">
          {props.notice}
        </p>
      )}

      <div class="connect-grid">
        <form class="connect-form" onSubmit={submit} autocomplete="off">
          <h2>New connection</h2>
          <label class="field">
            Remote ID
            <input
              ref={idRef}
              class="id-input"
              name="peer"
              inputMode="numeric"
              autoFocus={autoFocus && !peerId}
              value={peerId}
              onInput={onIdInput}
              placeholder="123 456 789"
              autocapitalize="off"
              spellcheck={false}
              required
            />
          </label>
          <div class="field">
            <label for="connect-pw">Password</label>
            <div class="pw-row">
              <input
                id="connect-pw"
                ref={pwRef}
                name="password"
                type={showPw ? "text" : "password"}
                autoFocus={autoFocus && !!peerId}
                autocomplete="current-password"
                aria-describedby="connect-pw-hint"
                value={password}
                onInput={(e) => {
                  setPassword(e.currentTarget.value);
                  props.onForgetPassword();
                }}
              />
              <button
                type="button"
                aria-pressed={showPw}
                onClick={() => setShowPw(!showPw)}
              >
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
            <span id="connect-pw-hint" class="hint">
              Leave empty to ask the person at the remote to accept. Passwords
              are never saved.
            </span>
          </div>
          <button type="submit" class="primary" disabled={!valid}>
            Connect
          </button>
        </form>

        <section
          class={recent.length ? "saved has-items" : "saved"}
          aria-labelledby="saved-h"
        >
          <h2 id="saved-h">Saved remotes</h2>
          {recent.length > 0 && (
            <ul class="peers">
              {recent.map((p) => (
                <li key={p.id}>
                  <div class="peer-info">
                    {renaming === p.id ? (
                      <input
                        class="rename"
                        aria-label={`Name for ${formatId(p.id)}`}
                        value={draft}
                        maxLength={60}
                        autoFocus
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            finishRename(p, true);
                          } else if (e.key === "Escape") finishRename(p, false);
                        }}
                        onBlur={() => finishRename(p, true)}
                      />
                    ) : (
                      <span class={p.name ? "peer-name" : "peer-name mono"}>
                        {label(p)}
                      </span>
                    )}
                    <span class="peer-meta">
                      {p.name && <span class="mono">{formatId(p.id)}</span>}
                      {[p.platform, lastSeen(p.at)]
                        .filter(Boolean)
                        .map((t, i) => (
                          <span key={i}>
                            {(p.name || i > 0) && " · "}
                            {t}
                          </span>
                        ))}
                      {!p.name && renaming !== p.id && (
                        <>
                          {" · "}
                          <button
                            type="button"
                            class="link"
                            onClick={() => startRename(p)}
                          >
                            Add a name
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    class="peer-connect"
                    aria-label={`Connect to ${label(p)}`}
                    onClick={() => {
                      setPeerId(formatId(p.id));
                      props.onForgetPassword();
                      pwRef.current?.focus();
                    }}
                  >
                    Connect
                  </button>
                  <div class="peer-menu-wrap">
                    <button
                      type="button"
                      class="peer-more"
                      aria-label={`More for ${label(p)}: rename, forget`}
                      aria-haspopup="menu"
                      aria-expanded={menu === p.id}
                      ref={(el) => {
                        if (el) moreRefs.current.set(p.id, el);
                        else moreRefs.current.delete(p.id);
                      }}
                      onClick={() => setMenu(menu === p.id ? undefined : p.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && menu === p.id)
                          closeMenu(p.id);
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <circle cx="5" cy="12" r="1.8" />
                        <circle cx="12" cy="12" r="1.8" />
                        <circle cx="19" cy="12" r="1.8" />
                      </svg>
                    </button>
                    {menu === p.id && (
                      <div
                        class="peer-menu"
                        role="menu"
                        onKeyDown={(e) => onMenuKey(e, p)}
                        onFocusOut={(e) => {
                          const to = e.relatedTarget as Node | null;
                          if (to && !e.currentTarget.contains(to))
                            setMenu(undefined);
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          ref={(el) => {
                            if (
                              el &&
                              !el.parentElement?.contains(
                                document.activeElement,
                              )
                            )
                              el.focus();
                          }}
                          onClick={() => startRename(p)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenu(undefined);
                            setRecent(forgetPeer(recent, p.id));
                          }}
                        >
                          Forget
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <label class="remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => onRememberChange(e.currentTarget.checked)}
            />
            Remember remotes on this device
          </label>
          {confirmClear && (
            <div class="confirm" role="group" aria-label="Confirm clearing">
              <p>
                Clear {recent.length} saved{" "}
                {recent.length === 1 ? "remote" : "remotes"} and their view
                settings, and stop remembering new ones?
              </p>
              <div class="lost-actions">
                <button
                  type="button"
                  class="danger"
                  autoFocus
                  onClick={() => {
                    setRecent(forgetAll(recent));
                    saveRemember(false);
                    setRemember(false);
                    setConfirmClear(false);
                  }}
                >
                  Clear and stop remembering
                </button>
                <button type="button" onClick={() => setConfirmClear(false)}>
                  Keep
                </button>
              </div>
            </div>
          )}
          <p class="hint">
            Names and IDs are kept in this browser only. Forgetting a remote
            also removes its saved view settings.
          </p>
        </section>
      </div>
    </main>
  );
}
