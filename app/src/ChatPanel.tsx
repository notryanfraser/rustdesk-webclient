// Chat panel: messages with the person at the remote machine, for this session only. On
// the remote they appear in RustDesk's connection window ("Write a message"). Text is rendered as
// text, never as HTML.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatEntry } from "./live";

export function ChatPanel(props: {
  peerId: string;
  entries: ChatEntry[];
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Newest at the bottom, kept in view.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.entries.length]);
  useEffect(() => input.current?.focus(), []);

  const send = () => {
    if (!draft.trim()) return;
    props.onSend(draft);
    setDraft("");
  };

  return (
    <aside class="chat" aria-label="Chat">
      <header>
        <h2>Chat with {props.peerId}</h2>
        <button type="button" onClick={props.onClose} aria-label="Close chat">
          ×
        </button>
      </header>
      <ol ref={list} class="messages" aria-label="Messages" aria-live="polite">
        {props.entries.length === 0 && (
          <li class="empty">
            Messages appear in RustDesk's window on the remote machine, and
            replies typed there show up here.
          </li>
        )}
        {props.entries.map((m, i) => (
          <li key={i} class={m.from}>
            <span class="who">{m.from === "me" ? "You" : "Remote"}</span>
            <time dateTime={new Date(m.at).toISOString()}>
              {new Date(m.at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <p>{m.text}</p>
          </li>
        ))}
      </ol>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={input}
          aria-label="Type a message"
          rows={2}
          value={draft}
          placeholder="Message (Enter to send, Shift+Enter for a new line)"
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}
