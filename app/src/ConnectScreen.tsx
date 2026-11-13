// Connect screen: peer ID + password, recent peers (IDs only), and the outcome of the last attempt.
import { useRef, useState } from "preact/hooks";
import type { ErrorDescription } from "@rustdesk-web/core";
import { forgetPeer, loadRecent, type RecentPeer } from "./recent";

/** RustDesk IDs are shown grouped ("123 456 789"); accept spaces and dashes. */
export const normalizeId = (s: string) => s.replace(/[\s-]/g, "");

export function ConnectScreen(props: {
  error?: ErrorDescription;
  notice?: string;
  initialPeerId?: string;
  onConnect: (peerId: string, password: string) => void;
}) {
  const [recent, setRecent] = useState<RecentPeer[]>(loadRecent);
  const [peerId, setPeerId] = useState(
    props.initialPeerId ?? recent[0]?.id ?? "",
  );
  const [password, setPassword] = useState("");
  const pwRef = useRef<HTMLInputElement>(null);
  const id = normalizeId(peerId);
  const valid = /^[A-Za-z0-9_]{6,}$/.test(id);

  const submit = (e: Event) => {
    e.preventDefault();
    if (valid) props.onConnect(id, password);
  };

  return (
    <main class="connect">
      <h1>rustdesk-web</h1>
      <form onSubmit={submit} autocomplete="off">
        <label>
          Remote ID
          <input
            name="peer"
            inputMode="numeric"
            autoFocus={!peerId}
            value={peerId}
            onInput={(e) => setPeerId(e.currentTarget.value)}
            placeholder="e.g. 123 456 789"
            required
          />
        </label>
        <label>
          Password
          <input
            ref={pwRef}
            name="password"
            type="password"
            autoFocus={!!peerId}
            autocomplete="current-password"
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
            placeholder="Leave empty to ask the remote user to accept"
          />
        </label>
        <button type="submit" disabled={!valid}>
          Connect
        </button>
      </form>

      {props.error && (
        <div class="error" role="alert">
          <p>{props.error.userMessage}</p>
          <details>
            <summary>Details</summary>
            <code>
              {props.error.layer}/{props.error.code}: {props.error.detail}
            </code>
          </details>
        </div>
      )}
      {!props.error && props.notice && (
        <p class="notice" role="status">
          {props.notice}
        </p>
      )}

      {recent.length > 0 && (
        <section class="recent" aria-label="Recent connections">
          <h2>Recent</h2>
          <ul>
            {recent.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  class="peer"
                  onClick={() => {
                    setPeerId(p.id);
                    pwRef.current?.focus();
                  }}
                >
                  {p.id.replace(/(\d)(?=(\d{3})+$)/g, "$1 ")}
                </button>
                <button
                  type="button"
                  class="forget"
                  aria-label={`Forget ${p.id}`}
                  title="Forget"
                  onClick={() => setRecent(forgetPeer(recent, p.id))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
