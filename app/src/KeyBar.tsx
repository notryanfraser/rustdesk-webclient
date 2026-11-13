// Key bar for touch devices: the phone's soft keyboard (through a hidden text field) and
// the keys a soft keyboard lacks. Modifiers latch until the next key: tap Ctrl, then "c" on the
// soft keyboard (or a bar key) sends Ctrl+C by position. Plain typing goes as text (translate
// mode, keyboard.ts textKeyEvent): the peer types the characters whatever its layout.
import { useRef, useState } from "preact/hooks";
import type { InputController } from "@rustdesk-web/core";

const MODIFIERS = [
  { label: "Ctrl", code: "ControlLeft" },
  { label: "Alt", code: "AltLeft" },
  { label: "Shift", code: "ShiftLeft" },
  { label: "Win", code: "MetaLeft" },
] as const;

const KEYS = [
  { label: "Esc", code: "Escape" },
  { label: "Tab", code: "Tab" },
  { label: "←", code: "ArrowLeft", name: "Left" },
  { label: "↑", code: "ArrowUp", name: "Up" },
  { label: "↓", code: "ArrowDown", name: "Down" },
  { label: "→", code: "ArrowRight", name: "Right" },
  { label: "Del", code: "Delete" },
  { label: "Home", code: "Home" },
  { label: "End", code: "End" },
] as const;

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

export function KeyBar(props: {
  input: () => InputController | undefined;
  zoomed: boolean;
  onResetZoom: () => void;
  macPeer: boolean;
}) {
  const [latched, setLatched] = useState<string[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);

  /** Press `code` with the latched modifiers, then release all; clears the latch. */
  const press = (code: string) => {
    props.input()?.sendKeys([...latched, code]);
    setLatched([]);
  };
  const text = (t: string) => {
    if (!t) return;
    const code =
      latched.length && [...t].length === 1 ? codeForChar(t) : undefined;
    if (code) return press(code);
    props.input()?.sendText(t);
    if (latched.length) setLatched([]);
  };
  const toggle = (code: string) =>
    setLatched((l) =>
      l.includes(code) ? l.filter((c) => c !== code) : [...l, code],
    );

  return (
    <nav
      class="keybar"
      aria-label="Keys"
      // Buttons must not take focus from the text field: that would close the soft keyboard (and a
      // latched Ctrl would then miss the letter typed next).
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) e.preventDefault();
      }}
    >
      <button
        type="button"
        aria-label="Keyboard"
        title="Show the keyboard"
        onClick={() => {
          const el = field.current;
          if (!el) return;
          resetField(el);
          el.focus();
        }}
      >
        ⌨
      </button>
      {MODIFIERS.map((m) => (
        <button
          key={m.code}
          type="button"
          aria-pressed={latched.includes(m.code)}
          onClick={() => toggle(m.code)}
        >
          {m.code === "MetaLeft" && props.macPeer ? "⌘" : m.label}
        </button>
      ))}
      {KEYS.map((k) => (
        <button
          key={k.code}
          type="button"
          aria-label={"name" in k ? k.name : k.label}
          onClick={() => press(k.code)}
        >
          {k.label}
        </button>
      ))}
      {props.zoomed && (
        <button type="button" onClick={props.onResetZoom}>
          1:1
        </button>
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
