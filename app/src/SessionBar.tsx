// The session chrome around the screen, one piece per layout: the session bar (wide), the status
// strip + bottom row (narrow), the rail (short landscape). SessionView picks which to render.
import type { ComponentChildren, JSX, Ref } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  KeyboardIcon,
  KeysIcon,
  MenuIcon,
  MoreIcon,
  PowerIcon,
  SignalIcon,
} from "./icons";

export interface BarItem {
  key: string;
  label: string;
  icon: ComponentChildren;
  /** The event tells panel buttons which control to return focus to. */
  onClick: (e: MouseEvent) => void;
  pressed?: boolean;
  disabled?: boolean;
  title?: string;
  /** Accessible name when it differs from the label ("Chat, 2 unread"). */
  ariaLabel?: string;
  /** Count shown as a badge. */
  badge?: number;
  /** Progress beside the label ("1 transfer · 62%"); the short form where the bar is narrower. */
  status?: string;
  statusShort?: string;
}

/** Peer-measured round trip -> bars and a word. Colour is only a third cue. */
export function signalOf(ms: number) {
  if (ms < 0) return { level: 0 as const, word: "", tone: "wait" };
  if (ms < 80) return { level: 3 as const, word: "Good", tone: "good" };
  if (ms < 200) return { level: 2 as const, word: "Fair", tone: "fair" };
  return { level: 1 as const, word: "Poor", tone: "poor" };
}

/** Deliberately not a live region: the number changes every few seconds. */
export function ConnectionChip(props: { delayMs: number; short?: boolean }) {
  const s = signalOf(props.delayMs);
  const text =
    props.delayMs < 0
      ? "…"
      : props.short
        ? `${props.delayMs} ms`
        : `${s.word} · ${props.delayMs} ms`;
  return (
    <span
      class={`chip chip-${s.tone}`}
      role={props.short ? "img" : undefined}
      aria-label={
        props.short
          ? props.delayMs < 0
            ? "Connection not measured yet"
            : `Connection ${s.word.toLowerCase()}, ${props.delayMs} milliseconds`
          : undefined
      }
    >
      <SignalIcon level={s.level} />
      <span aria-hidden={props.short ? "true" : undefined}>{text}</span>
    </span>
  );
}

/** The label is constant so a screen reader is not told the time every second. */
export function RecChip(props: { clock: string; short?: boolean }) {
  return (
    <span class="rec" role="status" aria-label="Recording">
      <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
        <circle cx="5" cy="5" r="5" fill="currentColor" />
      </svg>
      <span aria-hidden="true">
        REC{!props.short && <span class="clock"> {props.clock}</span>}
      </span>
    </span>
  );
}

function BarButton(props: { item: BarItem }) {
  const b = props.item;
  return (
    <button
      type="button"
      class={b.pressed ? "on" : undefined}
      data-key={b.key}
      disabled={b.disabled}
      aria-pressed={b.pressed}
      aria-label={b.ariaLabel}
      title={b.title}
      onClick={b.onClick}
    >
      {b.icon}
      <span class="lbl">{b.label}</span>
      {b.status && <span class="status">{b.status}</span>}
      {b.statusShort && <span class="status-short">{b.statusShort}</span>}
      {!!b.badge && (
        <span class="badge" aria-hidden="true">
          {b.badge > 99 ? "99+" : b.badge}
        </span>
      )}
    </button>
  );
}

type KeyHandler = JSX.KeyboardEventHandler<HTMLElement>;

export function SessionBar(props: {
  peer: string;
  title?: string;
  delayMs: number;
  /** The clock while recording. */
  rec?: string;
  display: ComponentChildren;
  input: BarItem[];
  session: BarItem[];
  panels: BarItem[];
  /** Too narrow for the Session group: it moves into a "More" menu. */
  compact: boolean;
  onDisconnect: () => void;
  onKeyDown: KeyHandler;
}) {
  const [more, setMore] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMore(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [more]);
  const group = (name: string, items: BarItem[]) => (
    <div role="group" aria-label={name} class="group">
      {items.map((b) => (
        <BarButton key={b.key} item={b} />
      ))}
    </div>
  );
  return (
    <header
      class="bar"
      aria-label="Session controls"
      onKeyDown={props.onKeyDown}
    >
      <span class="peer" title={props.title}>
        {props.peer}
      </span>
      <ConnectionChip delayMs={props.delayMs} />
      {props.display}
      {props.rec && <RecChip clock={props.rec} />}
      <span class="spacer" />
      {group("Input", props.input)}
      {props.compact ? (
        <div class="more-wrap group" ref={wrap}>
          <button
            ref={moreBtn}
            type="button"
            class={more ? "on" : undefined}
            aria-expanded={more}
            aria-controls="session-more"
            onClick={() => setMore(!more)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && more) {
                e.stopPropagation();
                setMore(false);
              }
            }}
          >
            <MoreIcon />
            <span class="lbl">More</span>
          </button>
          {more && (
            <div
              class="popover"
              id="session-more"
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                setMore(false);
                moreBtn.current?.focus();
              }}
              onClick={() => setMore(false)}
            >
              {props.session.map((b) => (
                <BarButton key={b.key} item={b} />
              ))}
            </div>
          )}
        </div>
      ) : (
        group("Session", props.session)
      )}
      {group("Panels", props.panels)}
      <button type="button" class="danger" onClick={props.onDisconnect}>
        <PowerIcon />
        <span class="lbl">Disconnect</span>
      </button>
    </header>
  );
}

/** Narrow layouts: who and how it is going; the controls are in the bottom row and the sheet. */
export function StatusStrip(props: {
  peer: string;
  title?: string;
  delayMs: number;
  rec?: string;
}) {
  return (
    <div class="strip">
      <span class="peer" title={props.title}>
        {props.peer}
      </span>
      <ConnectionChip delayMs={props.delayMs} />
      <span class="spacer" />
      {props.rec && <RecChip clock={props.rec} />}
    </div>
  );
}

/** Narrow layouts: Keys and Menu within thumb reach, directly above the key bar. */
export function BottomRow(props: {
  keys: boolean;
  onKeys: () => void;
  keysDisabled: boolean;
  menuRef: Ref<HTMLButtonElement>;
  onMenu: () => void;
  onKeyDown: KeyHandler;
}) {
  return (
    <div class="bottom-row" onKeyDown={props.onKeyDown}>
      <button
        type="button"
        class={props.keys ? "on" : undefined}
        aria-pressed={props.keys}
        disabled={props.keysDisabled}
        onClick={props.onKeys}
      >
        <KeysIcon />
        Keys
      </button>
      <button
        ref={props.menuRef}
        type="button"
        class="menu-btn"
        aria-haspopup="dialog"
        onClick={props.onMenu}
      >
        <MenuIcon />
        Menu
      </button>
    </div>
  );
}

/** Short landscape: the controls stand in a rail beside the screen, not over it. */
export function Rail(props: {
  delayMs: number;
  rec?: string;
  keys: boolean;
  onKeys: () => void;
  onType: () => void;
  disabled: boolean;
  menuRef: Ref<HTMLButtonElement>;
  onMenu: () => void;
  onKeyDown: KeyHandler;
}) {
  return (
    <nav class="rail" aria-label="Session controls" onKeyDown={props.onKeyDown}>
      <ConnectionChip delayMs={props.delayMs} short />
      {props.rec && <RecChip clock={props.rec} short />}
      <span class="spacer" />
      <button
        type="button"
        class={props.keys ? "on" : undefined}
        aria-pressed={props.keys}
        disabled={props.disabled}
        onClick={props.onKeys}
      >
        <KeysIcon size={20} />
        Keys
      </button>
      <button type="button" disabled={props.disabled} onClick={props.onType}>
        <KeyboardIcon size={20} />
        Type
      </button>
      <button
        ref={props.menuRef}
        type="button"
        class="menu-btn"
        aria-haspopup="dialog"
        onClick={props.onMenu}
      >
        <MenuIcon size={20} />
        Menu
      </button>
    </nav>
  );
}
