// The Menu sheet (narrow and short-landscape layouts) and the disconnect confirmation, in the
// sheet or, on wide layouts, as a small dialog. Both are modal: focus moves in, stays in, and
// goes back to where it came from; Escape closes.
import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { CloseIcon, PowerIcon } from "./icons";

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

function useModal(
  box: RefObject<HTMLElement>,
  onClose: () => void,
  returnFocus?: RefObject<HTMLElement>,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    // A child may have taken focus already (the confirmation's default button).
    if (!el.contains(document.activeElement))
      el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return close.current();
      }
      if (e.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return e.preventDefault();
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !el.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !el.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      // Not the opener's own node when it was replaced meanwhile (a layout change): the ref wins.
      (returnFocus?.current ?? opener)?.focus();
    };
  }, []);
}

/** "A recording is running and a download is at 62%. They will stop." */
function sentence(reasons: string[]): string {
  const joined = reasons.join(" and ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}. ${reasons.length === 1 ? "It" : "They"} will stop.`;
}

export function DisconnectConfirm(props: {
  peer: string;
  reasons: string[];
  onStay: () => void;
  onDisconnect: () => void;
  titleId: string;
}) {
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => stay.current?.focus(), []);
  return (
    <div class="confirm">
      <p id={props.titleId}>
        <strong>Disconnect from {props.peer}?</strong> {sentence(props.reasons)}
      </p>
      <button ref={stay} type="button" class="primary" onClick={props.onStay}>
        Stay connected
      </button>
      <button type="button" class="danger" onClick={props.onDisconnect}>
        Disconnect anyway
      </button>
    </div>
  );
}

export interface SheetItem {
  key: string;
  label: string;
  icon: ComponentChildren;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  /** Shown beside the label ("2 new"). */
  note?: string;
}

export function MenuSheet(props: {
  peer: string;
  /** "Windows · Display 1 of 2 · 1920×1080" */
  subtitle: string;
  items: SheetItem[];
  /** Reasons a disconnect would lose something: asks first while this is set. */
  confirm?: string[];
  returnFocus: RefObject<HTMLElement>;
  onClose: () => void;
  onDisconnect: () => void;
  onDisconnectNow: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const confirmId = useId();
  useModal(box, props.onClose, props.returnFocus);
  return (
    <div
      class="scrim sheet-scrim"
      onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        class="sheet"
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="Session menu"
      >
        <div class="sheet-head">
          <div>
            <h2>{props.peer}</h2>
            <p>{props.subtitle}</p>
          </div>
          <button
            type="button"
            class="icon-btn"
            aria-label="Close menu"
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </div>
        {props.confirm ? (
          <DisconnectConfirm
            peer={props.peer}
            reasons={props.confirm}
            titleId={confirmId}
            onStay={props.onClose}
            onDisconnect={props.onDisconnectNow}
          />
        ) : (
          <>
            <div class="sheet-grid">
              {props.items.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  disabled={b.disabled}
                  aria-pressed={b.pressed}
                  onClick={b.onClick}
                >
                  {b.icon}
                  <span>
                    {b.label}
                    {b.note && <span class="note"> · {b.note}</span>}
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              class="danger sheet-disconnect"
              onClick={props.onDisconnect}
            >
              <PowerIcon />
              Disconnect
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The confirmation as a small modal dialog, for the layouts without the sheet. */
export function ConfirmDialog(props: {
  peer: string;
  reasons: string[];
  returnFocus?: RefObject<HTMLElement>;
  onStay: () => void;
  onDisconnect: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const title = useId();
  useModal(box, props.onStay, props.returnFocus);
  return (
    <div class="scrim dialog-scrim">
      <div
        class="dialog"
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
      >
        <DisconnectConfirm
          peer={props.peer}
          reasons={props.reasons}
          titleId={title}
          onStay={props.onStay}
          onDisconnect={props.onDisconnect}
        />
      </div>
    </div>
  );
}
