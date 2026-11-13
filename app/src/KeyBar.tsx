// Key deck for touch devices: the phone's soft keyboard (through a hidden text field) and the keys
// a soft keyboard lacks. A modifier taps through three states: latched (until the next key: tap
// Ctrl, then "c" on the soft keyboard or a deck key sends Ctrl+C by position), locked (a second
// tap: held until tapped again, so Alt stays down while Tab is pressed again and again) and off.
// Plain typing goes as text (translate mode, keyboard.ts textKeyEvent): the peer types the
// characters whatever its layout.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { InputController } from "@rustdesk-web/core";
import { ArrowIcon, KeyboardIcon, LockIcon } from "./icons";
import type { PointerMode } from "./settings";

/** A held key repeats after this long, then at the interval (ms). */
const REPEAT_DELAY = 400;
const REPEAT_EVERY = 60;

const MODIFIERS = [
  { label: "Ctrl", name: "Ctrl", code: "ControlLeft" },
  { label: "Alt", name: "Alt", code: "AltLeft" },
  { label: "Shift", name: "Shift", code: "ShiftLeft" },
  { label: "Win", name: "Win", code: "MetaLeft" },
] as const;

const ARROWS = [
  { dir: "left", name: "Left", code: "ArrowLeft" },
  { dir: "up", name: "Up", code: "ArrowUp" },
  { dir: "down", name: "Down", code: "ArrowDown" },
  { dir: "right", name: "Right", code: "ArrowRight" },
] as const;

const FKEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);

/** Second page, after the F-keys: [label, name, code]. */
const EDITING = [
  ["Del", "Delete", "Delete"],
  ["Home", "Home", "Home"],
  ["End", "End", "End"],
  ["PgUp", "Page up", "PageUp"],
  ["PgDn", "Page down", "PageDown"],
  ["Bksp", "Backspace", "Backspace"],
] as const;

/** Combos sent in one press, whatever is latched: [label, codes]; Ctrl+Alt+Del has its own action. */
const COMBOS = [
  ["Alt+Tab", ["AltLeft", "Tab"]],
  ["Win+D", ["MetaLeft", "KeyD"]],
  ["Ctrl+Alt+Del", "cad"],
  ["Ctrl+Shift+Esc", ["ControlLeft", "ShiftLeft", "Escape"]],
] as const;

/** Keys that repeat while held. */
const REPEATING = new Set([
  "ArrowLeft",
  "ArrowUp",
  "ArrowDown",
  "ArrowRight",
  "Delete",
  "Backspace",
]);

/**
 * The text field always holds this one character, caret after it: in an empty field Backspace
 * has nothing to delete, fires no beforeinput, and soft keyboards send no usable keydown either.
 */
const SENTINEL = " ";
function resetField(el: HTMLTextAreaElement): void {
  el.value = SENTINEL;
  el.setSelectionRange(SENTINEL.length, SENTINEL.length);
}

/** KeyboardEvent.code for a typed character, for shortcuts (Ctrl+c); undefined if none. */
function codeForChar(c: string): string | undefined {
  if (/^[a-z]$/i.test(c)) return `Key${c.toUpperCase()}`;
  if (/^[0-9]$/.test(c)) return `Digit${c}`;
  return { " ": "Space", "\n": "Enter" }[c];
}

/**
 * One deck key. Keys that repeat act on pointer down and again while held; a click that follows a
 * pointer is ignored (only a keyboard's Enter or Space, which has no click count, acts on click).
 */
function Key(props: {
  label: ComponentChildren;
  /** Accessible name when the label is not text. */
  name?: string;
  repeat?: boolean;
  class?: string;
  onPress: () => void;
}) {
  const timer = useRef<number>();
  const press = useRef(props.onPress);
  press.current = props.onPress;
  const stop = () => {
    clearTimeout(timer.current);
    clearInterval(timer.current);
    timer.current = undefined;
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      class={props.class}
      aria-label={props.name}
      onClick={(e) => {
        if (!props.repeat || e.detail === 0) props.onPress();
      }}
      onPointerDown={
        props.repeat
          ? (e) => {
              if (e.button !== 0) return;
              stop();
              press.current();
              timer.current = window.setTimeout(() => {
                timer.current = window.setInterval(
                  () => press.current(),
                  REPEAT_EVERY,
                );
              }, REPEAT_DELAY);
            }
          : undefined
      }
      onPointerUp={props.repeat ? stop : undefined}
      onPointerCancel={props.repeat ? stop : undefined}
      onPointerLeave={props.repeat ? stop : undefined}
      onBlur={props.repeat ? stop : undefined}
      // A long press on a touch screen would open a context menu.
      onContextMenu={props.repeat ? (e) => e.preventDefault() : undefined}
    >
      {props.label}
    </button>
  );
}

type ModState = "off" | "latched" | "locked";

export function KeyBar(props: {
  input: () => InputController | undefined;
  zoomed: boolean;
  onResetZoom: () => void;
  onCtrlAltDel: () => void;
  macPeer: boolean;
  /** Phones in portrait: two rows of keys, the second page in place of them. */
  narrow: boolean;
  pointerMode: PointerMode;
  onPointerMode: (m: PointerMode) => void;
}) {
  const [latched, setLatched] = useState<string[]>([]);
  const [locked, setLocked] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLElement>(null);
  // Repeating keys call the closure of their pointer down: read the modifiers from here.
  const mods = useRef({ latched, locked });
  const setMods = (l: string[], k: string[]) => {
    mods.current = { latched: l, locked: k };
    setLatched(l);
    setLocked(k);
  };

  /** Press `code` with the modifiers held, then release all; clears the latch, not the lock. */
  const press = (code: string) => {
    const { latched: l, locked: k } = mods.current;
    props.input()?.sendKeys([...k, ...l.filter((c) => !k.includes(c)), code]);
    if (l.length) setMods([], k);
  };
  const text = (t: string) => {
    if (!t) return;
    const { latched: l, locked: k } = mods.current;
    const code =
      l.length + k.length && [...t].length === 1 ? codeForChar(t) : undefined;
    if (code) return press(code);
    props.input()?.sendText(t);
    if (l.length) setMods([], k);
  };
  const stateOf = (code: string): ModState =>
    locked.includes(code)
      ? "locked"
      : latched.includes(code)
        ? "latched"
        : "off";
  /** Off, latched, locked, off. */
  const tap = (code: string) => {
    const { latched: l, locked: k } = mods.current;
    if (k.includes(code))
      setMods(
        l,
        k.filter((c) => c !== code),
      );
    else if (l.includes(code))
      setMods(
        l.filter((c) => c !== code),
        [...k, code],
      );
    else setMods([...l, code], k);
  };
  const combo = (codes: readonly string[]) =>
    props.input()?.sendKeys([...codes]);

  // The popover (wider layouts): Escape and a tap outside close it.
  useEffect(() => {
    if (!more || props.narrow) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMore(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [more, props.narrow]);

  const modKey = (m: (typeof MODIFIERS)[number]) => {
    const state = stateOf(m.code);
    const mac = m.code === "MetaLeft" && props.macPeer;
    const name = mac ? "Command" : m.name;
    return (
      <button
        key={m.code}
        type="button"
        class="mod"
        data-state={state}
        aria-pressed={state !== "off"}
        aria-label={
          state === "locked"
            ? `${name}, locked`
            : state === "latched"
              ? `${name}, on for the next key`
              : name
        }
        title={
          state === "off"
            ? "Tap for the next key, twice to hold"
            : state === "latched"
              ? "On for the next key. Tap again to hold"
              : "Held. Tap to release"
        }
        onClick={() => tap(m.code)}
      >
        {mac ? "⌘" : m.label}
        {state === "locked" && <LockIcon size={14} />}
      </button>
    );
  };
  const arrowKey = (a: (typeof ARROWS)[number]) => (
    <Key
      key={a.code}
      name={a.name}
      repeat
      label={<ArrowIcon dir={a.dir} size={20} />}
      onPress={() => press(a.code)}
    />
  );
  const typeKey = (
    <button
      type="button"
      class="type"
      aria-label={props.narrow ? undefined : "Show the on-screen keyboard"}
      title="Show the keyboard"
      onClick={() => {
        const el = field.current;
        if (!el) return;
        resetField(el);
        el.focus();
      }}
    >
      <KeyboardIcon size={20} />
      {props.narrow && "Type"}
    </button>
  );
  const pointerKey = (
    <button
      type="button"
      class="pointer-mode"
      aria-label={`Pointer mode: ${props.pointerMode}`}
      aria-pressed={props.pointerMode === "trackpad"}
      title="Switch between direct touch and a trackpad cursor"
      onClick={() =>
        props.onPointerMode(
          props.pointerMode === "trackpad" ? "touch" : "trackpad",
        )
      }
    >
      {props.pointerMode === "trackpad" ? "Trackpad" : "Touch"}
    </button>
  );
  const fitKey = props.zoomed && (
    <button
      type="button"
      class="fit"
      aria-label="Reset zoom"
      onClick={props.onResetZoom}
    >
      Fit
    </button>
  );
  // A modifier held on a page that does not show the modifiers is easy to forget.
  const held = MODIFIERS.filter((m) => stateOf(m.code) !== "off").map(
    (m) => `${m.name} (${stateOf(m.code)})`,
  );
  const page = (
    <div class="page" id="keys-page">
      {props.narrow && held.length > 0 && (
        <p class="held">Held: {held.join(", ")}</p>
      )}
      <div class="grid six">
        {FKEYS.map((f) => (
          <Key key={f} label={f} onPress={() => press(f)} />
        ))}
        {EDITING.map(([label, name, code]) => (
          <Key
            key={code}
            label={label}
            name={name === label ? undefined : name}
            repeat={REPEATING.has(code)}
            onPress={() => press(code)}
          />
        ))}
      </div>
      <div class="grid combos">
        {COMBOS.map(([label, codes]) => (
          <Key
            key={label}
            label={label}
            onPress={() =>
              codes === "cad" ? props.onCtrlAltDel() : combo(codes)
            }
          />
        ))}
      </div>
    </div>
  );

  return (
    <nav
      class={`keybar${props.narrow ? " narrow" : ""}`}
      aria-label="Keys"
      ref={wrap}
      // Buttons must not take focus from the text field: that would close the soft keyboard (and a
      // latched Ctrl would then miss the letter typed next).
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) e.preventDefault();
      }}
    >
      {props.narrow ? (
        <>
          {more ? (
            page
          ) : (
            <>
              <div class="grid four">{MODIFIERS.map(modKey)}</div>
              <div class="grid six">
                <Key label="Esc" onPress={() => press("Escape")} />
                <Key label="Tab" onPress={() => press("Tab")} />
                {ARROWS.map(arrowKey)}
              </div>
            </>
          )}
          <div class="grid foot">
            {typeKey}
            <button
              type="button"
              aria-pressed={more}
              onClick={() => setMore(!more)}
            >
              {more ? "Main keys" : "F-keys, combos"}
            </button>
            {pointerKey}
            {fitKey}
          </div>
        </>
      ) : (
        <>
          <div class="row">
            {typeKey}
            {MODIFIERS.map(modKey)}
            <span class="sep" aria-hidden="true" />
            <Key label="Esc" onPress={() => press("Escape")} />
            <Key label="Tab" onPress={() => press("Tab")} />
            {ARROWS.map(arrowKey)}
            <Key
              label="Del"
              name="Delete"
              repeat
              onPress={() => press("Delete")}
            />
            {fitKey}
            <span class="spacer" />
            {pointerKey}
            <button
              ref={moreBtn}
              type="button"
              aria-expanded={more}
              aria-controls="keys-page"
              onClick={() => setMore(!more)}
            >
              F-keys and combos
            </button>
          </div>
          {more && (
            <div
              class="keys-popover"
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                setMore(false);
                moreBtn.current?.focus();
              }}
            >
              {page}
            </div>
          )}
        </>
      )}
      {/* The soft keyboard types here; what it inserts goes to the remote and the field stays
          empty. beforeinput carries the text (Android sends no usable keydown: key
          "Unidentified"); compositions (predictive text, IMEs) arrive when they end. */}
      <textarea
        ref={field}
        class="soft-keyboard"
        aria-label="Type on the remote"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        {...{ autocorrect: "off" }}
        onBeforeInput={(e) => {
          const ev = e as InputEvent;
          switch (ev.inputType) {
            case "insertText":
              e.preventDefault();
              return text(ev.data ?? "");
            case "insertLineBreak":
            case "insertParagraph":
              e.preventDefault();
              return press("Enter");
            case "deleteContentBackward":
              e.preventDefault();
              return press("Backspace");
            case "deleteContentForward":
              e.preventDefault();
              return press("Delete");
          }
        }}
        onFocus={(e) => resetField(e.currentTarget)}
        onCompositionEnd={(e) => {
          text(e.data);
          resetField(e.currentTarget);
        }}
        onInput={(e) => {
          // Whatever was not cancelled (an unusual inputType): send it, then reset the field.
          const el = e.currentTarget;
          if ((e as InputEvent).isComposing) return;
          if (!el.value.startsWith(SENTINEL))
            press("Backspace"); // the sentinel was deleted
          else text(el.value.slice(SENTINEL.length));
          resetField(el);
        }}
        onKeyDown={(e) => {
          // Keys with no text (a hardware keyboard on a tablet: arrows, Escape...) by position.
          // (Backspace/Enter/Delete come as beforeinput; modifiers alone send nothing.)
          const ignore = [
            "Unidentified",
            "Process",
            "Backspace",
            "Enter",
            "Delete",
            "Shift",
            "Control",
            "Alt",
            "Meta",
            "CapsLock",
            "AltGraph",
          ];
          if (e.key.length > 1 && !e.isComposing && !ignore.includes(e.key)) {
            e.preventDefault();
            press(e.code);
          }
        }}
      />
    </nav>
  );
}
