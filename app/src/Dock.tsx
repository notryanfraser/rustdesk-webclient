// The side panel's header: one tab list (Chat, Files, Settings, Stats) and one Close button where
// the dock sits beside or over the screen; a plain title and Close on phones, where the dock
// covers everything and the panels are reached from the Menu.
import type { JSX, Ref } from "preact";
import { CloseIcon } from "./icons";

/** The side panel shows one of these at a time. */
export type PanelName = "chat" | "files" | "view" | "stats";

export const PANELS: { name: PanelName; label: string }[] = [
  { name: "chat", label: "Chat" },
  { name: "files", label: "Files" },
  { name: "view", label: "Settings" },
  { name: "stats", label: "Stats" },
];

export const tabId = (p: PanelName) => `dock-tab-${p}`;
export const panelId = (p: PanelName) => `dock-panel-${p}`;

export function DockHead(props: {
  panel: PanelName;
  /** Phones: a title instead of the tabs. */
  title: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onSelect: (p: PanelName) => void;
  onClose: () => void;
}) {
  // Roving tabindex: only the selected tab is in the tab order, the arrow keys move between them
  // (and select: a panel is cheap to show).
  const onKeyDown: JSX.KeyboardEventHandler<HTMLElement> = (e) => {
    const at = PANELS.findIndex((p) => p.name === props.panel);
    const to =
      e.key === "ArrowRight"
        ? (at + 1) % PANELS.length
        : e.key === "ArrowLeft"
          ? (at + PANELS.length - 1) % PANELS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? PANELS.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = PANELS[to]!.name;
    props.onSelect(next);
    document.getElementById(tabId(next))?.focus();
  };
  return (
    <div class="dock-head">
      {props.title ? (
        <h2 ref={props.headingRef} tabIndex={-1}>
          {PANELS.find((p) => p.name === props.panel)?.label}
        </h2>
      ) : (
        <div
          class="tabs"
          role="tablist"
          aria-label="Panels"
          onKeyDown={onKeyDown}
        >
          {PANELS.map((p) => (
            <button
              key={p.name}
              id={tabId(p.name)}
              type="button"
              role="tab"
              aria-selected={props.panel === p.name}
              aria-controls={panelId(p.name)}
              tabIndex={props.panel === p.name ? 0 : -1}
              onClick={() => props.onSelect(p.name)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        class="icon-btn"
        aria-label="Close panel"
        onClick={props.onClose}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
