// Clipboard sync between this browser and the remote, text only.
//
// remote -> local: the peer sends its clipboard when it changes (e.g. after Ctrl+C there); we
// write it with navigator.clipboard.writeText. Browsers may refuse that without a recent user
// gesture (Firefox); the text is then kept and written on the next click or key press here.
// local -> remote: when the paste shortcut is pressed on the remote screen, the browser fires a
// `paste` event carrying the local clipboard (no permission prompt in any browser); we send it
// to the peer, and InputController holds the keystroke back briefly so the peer has the new
// clipboard before it pastes (see InputControllerOptions.isPasteShortcut).
import {
  readClipboardMessage,
  textClipboardMessage,
  type Message,
} from "@rustdesk-web/core";

export interface ClipboardStatus {
  /** Remote -> local copies applied, and those waiting for a user gesture. */
  received: number;
  pending: boolean;
  /** Local -> remote clipboards sent. */
  sent: number;
  /** Last problem (decode failure, oversized, refused), for the stats overlay. */
  lastError?: string;
}

/** Ctrl+V / Cmd+V / Shift+Insert: what makes this browser paste. */
export const isPasteShortcut = (e: KeyboardEvent) =>
  (e.code === "KeyV" && (e.ctrlKey || e.metaKey) && !e.altKey) ||
  (e.code === "Insert" && e.shiftKey);

export class ClipboardSync {
  private status: ClipboardStatus = { received: 0, pending: false, sent: 0 };
  private pendingText: string | undefined;
  private lastSent: string | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly element: HTMLElement,
    private readonly send: (m: Message) => void,
    private readonly onStatus: (s: ClipboardStatus) => void = () => {},
  ) {
    const opts = { signal: this.abort.signal, capture: true };
    document.addEventListener("paste", (e) => this.onPaste(e), opts);
    // Any user gesture is a chance to apply a remote clipboard the browser refused earlier.
    for (const type of ["pointerdown", "keydown"] as const)
      document.addEventListener(type, () => this.flushPending(), opts);
  }

  /** Feed every session message; clipboard updates from the peer are applied locally. */
  onMessage(msg: Message): void {
    let text: string | undefined;
    try {
      text = readClipboardMessage(msg);
    } catch (e) {
      this.update({
        lastError: `remote clipboard dropped: ${(e as Error).message}`,
      });
      return;
    }
    if (text === undefined) return;
    // Do not echo it back on the next paste if the user pastes what the remote just copied.
    this.lastSent = text;
    this.pendingText = text;
    this.flushPending();
  }

  detach(): void {
    this.abort.abort();
  }

  private onPaste(e: ClipboardEvent): void {
    // Only pastes into a remote screen (with several displays, any of their canvases); not into
    // our own UI, such as the password or chat field.
    const active = document.activeElement;
    if (
      active !== this.element &&
      !(active instanceof HTMLCanvasElement && active.closest(".screen"))
    )
      return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text || text === this.lastSent) return;
    this.lastSent = text;
    this.send(textClipboardMessage(text));
    this.update({ sent: this.status.sent + 1 });
  }

  /** Apply the pending remote clipboard now; call it from a user gesture. */
  flushPending(): void {
    const text = this.pendingText;
    if (text === undefined || !navigator.clipboard?.writeText) return;
    this.pendingText = undefined;
    navigator.clipboard.writeText(text).then(
      () => {
        if (this.pendingText === undefined)
          this.update({
            received: this.status.received + 1,
            pending: false,
            lastError: undefined,
          });
      },
      () => {
        // Refused (no user gesture, or the page lost focus): try again on the next gesture,
        // unless a newer remote clipboard has replaced it meanwhile.
        this.pendingText ??= text;
        this.update({ pending: true });
      },
    );
  }

  private update(p: Partial<ClipboardStatus>): void {
    this.status = { ...this.status, ...p };
    this.onStatus(this.status);
  }
}
