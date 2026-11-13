// Status banners between the session bar and the screen. The region is always mounted (a live
// region must exist before its content changes to be announced); banners stay until the user
// acts on them or dismisses them, never on a timer.
import { useEffect, useRef } from "preact/hooks";
import { ClipboardIcon, CloseIcon, GestureIcon, MutedIcon } from "./icons";
import type { PointerMode } from "./settings";

/** [gesture, what it does]; the gesture is shown in bold. */
const GESTURES: Record<PointerMode, [string, string][]> = {
  touch: [
    ["Tap", "to click"],
    ["Hold", "for right-click"],
    ["Two fingers", "to scroll"],
    ["Pinch", "to zoom"],
  ],
  trackpad: [
    ["Drag", "to move the cursor"],
    ["Tap", "to click"],
    ["Hold or two-finger tap", "for right-click"],
    ["Tap then drag", "to drag"],
    ["Two fingers", "to scroll"],
    ["Pinch", "to zoom"],
  ],
};

function GestureList(props: { mode: PointerMode }) {
  return (
    <ul class="gestures" aria-label="Touch gestures">
      {GESTURES[props.mode].map(([gesture, what]) => (
        <li key={gesture}>
          <strong>{gesture}</strong> {what}
        </li>
      ))}
    </ul>
  );
}

/** Narrow portrait: a card in the free space around the screen, never over it. */
export function GestureCard(props: {
  mode: PointerMode;
  /** Shown on request (the Menu): take focus so it is noticed. */
  focus: boolean;
  onDismiss: () => void;
}) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.focus) ok.current?.focus();
  }, []);
  return (
    <section class="gesture-card" aria-label="Touch gestures help">
      <GestureList mode={props.mode} />
      <button ref={ok} type="button" onClick={props.onDismiss}>
        Got it
      </button>
    </section>
  );
}

export function Banners(props: {
  soundPaused: boolean;
  onSoundOn: () => void;
  onDismissSound: () => void;
  clipboardPending: boolean;
  onCopy: () => void;
  /** Recording stopped / could not start; announced as an alert. */
  note: string;
  onDismissNote: () => void;
  /** Gesture help as a banner (layouts without room for the card). */
  gestures?: { mode: PointerMode; onDismiss: () => void };
}) {
  return (
    <div class="banners" role="status">
      {props.soundPaused && (
        <div class="banner warn">
          <MutedIcon size={20} />
          <span>The browser has paused sound from the remote.</span>
          <button type="button" class="primary" onClick={props.onSoundOn}>
            Turn sound on
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="Dismiss"
            onClick={props.onDismissSound}
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {props.clipboardPending && (
        <div class="banner info">
          <ClipboardIcon size={20} />
          <span>The remote copied text.</span>
          <button type="button" class="primary" onClick={props.onCopy}>
            Copy to this device
          </button>
        </div>
      )}
      {props.gestures && (
        <div class="banner info gesture-banner">
          <GestureIcon size={20} />
          <GestureList mode={props.gestures.mode} />
          <button
            type="button"
            class="icon-btn"
            aria-label="Dismiss gesture help"
            onClick={props.gestures.onDismiss}
          >
            <CloseIcon />
          </button>
        </div>
      )}
      {props.note && (
        <div class="banner bad" role="alert">
          <span>{props.note}</span>
          <button
            type="button"
            class="icon-btn"
            aria-label="Dismiss"
            onClick={props.onDismissNote}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}
