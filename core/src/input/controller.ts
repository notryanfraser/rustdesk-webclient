// InputController: binds an element showing the remote screen (the video canvas) to a
// session: pointer, wheel and keyboard events become MouseEvent/KeyEvent messages. Browser-only
// at runtime; nothing is touched at import time. Mapping rules live in keyboard.ts / mouse.ts.
//
// Behaviour:
// * Keys go to the peer only while the element has focus (it gets tabindex=0; a click
// focuses it). Mapped keys are preventDefault()ed so Tab, Backspace, F5, Ctrl+S etc. reach
// the peer instead of the browser. The browser still keeps a few combos for itself
// (Ctrl/Cmd+W, Ctrl+T, Ctrl+N, Alt+Tab, ...); lockKeyboard() asks for the Keyboard Lock API
// (Chromium, fullscreen only) to capture those too, and sendKeys()/sendCtrlAltDel() exist
// for toolbar buttons. IME composition events are ignored (translate mode is).
// * Every key and button pressed through us is released on the peer when focus is lost or
// the page is hidden, so nothing stays stuck down on the remote (the native client does the
// same with its TO_RELEASE set, src/keyboard.rs).
// * Pointer moves are sent only when the remote position changes (several CSS px can map to
// one remote px when the view is scaled down).

import { create } from "@bufbuild/protobuf";
import { MessageSchema } from "../gen/message_pb.js";
import type {
  KeyEvent,
  Message,
  MouseEvent as RdMouseEvent,
} from "../gen/message_pb.js";
import type { PeerKeyPlatform } from "./keyboard.js";
import {
  ctrlAltDelEvent,
  legacyModifiers,
  mapKeyEvent,
  textKeyEvent,
  translateKeyEvents,
  peerKeyPlatform,
} from "./keyboard.js";
import type { RemoteGeometry } from "./mouse.js";
import {
  MOUSE_TYPE,
  WheelAccumulator,
  mouseEvent,
  mouseMask,
  rustdeskButton,
  toRemote,
} from "./mouse.js";

export interface InputControllerOptions {
  /** The element the remote screen is drawn in (object-fit: contain), e.g. the video canvas. */
  element: HTMLElement;
  send: (msg: Message) => void;
  /** PeerInfo.platform ("Windows", "Linux", "Mac OS"). */
  peerPlatform: string;
  /** Display shown in the element (origin in the peer's desktop + size). Update with setGeometry. */
  geometry: RemoteGeometry;
  /** Count of events sent, per kind (for tests and diagnostics). */
  onSent?: (kind: "key" | "mouse", ev: KeyEvent | RdMouseEvent) => void;
  /**
   * Keys that are the local paste shortcut (e.g. Ctrl/Cmd+V). For these the browser keeps its
   * default action, so it fires a `paste` event carrying the local clipboard (no permission
   * needed), and the key events are held back for `pasteDelayMs` (default 50, order kept) so a
   * clipboard update sent from that paste event reaches the peer before the keystroke does.
   */
  isPasteShortcut?: (e: KeyboardEvent) => boolean;
  pasteDelayMs?: number;
  /**
   * "map" (default): keys by position, the peer's layout applies. "translate": characters as
   * text, so the local layout applies (keyboard.ts translateKeyEvents). Change with
   * setKeyboardMode.
   */
  keyboardMode?: KeyboardInputMode;
  /**
   * Touch pointers: "mouse" (default) treats them like a mouse; "app" ignores them, for an app
   * gesture layer that drives pointerMove / pointerButton / scroll itself.
   */
  touch?: "mouse" | "app";
}

/** Where and how a pointer acts, in client (CSS) coordinates; the DOM button numbering. */
export interface PointerAt {
  clientX: number;
  clientY: number;
  button?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export type KeyboardInputMode = "map" | "translate";

export class InputController {
  private geometry: RemoteGeometry;
  private readonly peer: PeerKeyPlatform | undefined;
  private readonly wheel = new WheelAccumulator();
  private readonly keysDown = new Set<string>();
  /** Keys whose press went as text (translate mode): their release is not sent. */
  private readonly textKeysDown = new Set<string>();
  private keyboardMode: KeyboardInputMode;
  /**
   * Lock state as of the last real key event. The peer re-syncs its Caps/Num Lock to every
   * key event's modifiers, releases included, so synthetic events must carry it too.
   */
  private locks = { capsLock: false, numLock: false };
  private readonly buttonsDown = new Set<number>();
  private lastMove: { x: number; y: number } | undefined;
  private readonly abort = new AbortController();
  private enabled = true;

  constructor(private readonly opts: InputControllerOptions) {
    this.geometry = opts.geometry;
    this.peer = peerKeyPlatform(opts.peerPlatform);
    this.keyboardMode = opts.keyboardMode ?? "map";
    const el = opts.element;
    if (el.tabIndex < 0) el.tabIndex = 0;
    el.style.touchAction = "none";
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      passive = false,
    ) => el.addEventListener(type, fn, { signal: this.abort.signal, passive });
    const mine = (e: PointerEvent) =>
      e.pointerType !== "touch" || (opts.touch ?? "mouse") === "mouse";
    on("pointermove", (e) => mine(e) && this.onPointerMove(e));
    on("pointerdown", (e) => mine(e) && this.onPointerButton(e, true));
    on("pointerup", (e) => mine(e) && this.onPointerButton(e, false));
    on("wheel", (e) => this.onWheel(e));
    on("contextmenu", (e) => e.preventDefault());
    on("keydown", (e) => this.onKey(e, true));
    on("keyup", (e) => this.onKey(e, false));
    on("blur", () => this.releaseAll());
    document.addEventListener(
      "visibilitychange",
      () => document.hidden && this.releaseAll(),
      { signal: this.abort.signal },
    );
  }

  /** The shown display or its size changed (switch_display, resolution change). */
  setGeometry(g: RemoteGeometry): void {
    this.geometry = g;
    this.lastMove = undefined;
  }

  /** Stop sending (view-only) without detaching; releases anything held. */
  setEnabled(on: boolean): void {
    if (!on) this.releaseAll();
    this.enabled = on;
  }

  /** Ask the browser to deliver system shortcuts (Keyboard Lock API; Chromium, fullscreen only). */
  async lockKeyboard(): Promise<boolean> {
    const kb = (navigator as { keyboard?: { lock?: () => Promise<void> } })
      .keyboard;
    if (!kb?.lock) return false;
    try {
      await kb.lock();
      return true;
    } catch {
      return false;
    }
  }

  /** Press the keys (KeyboardEvent.code values) in order, then release them in reverse. */
  sendKeys(codes: string[]): void {
    if (!this.peer) return;
    for (const code of codes)
      this.sendKey(mapKeyEvent({ code, down: true, ...this.locks }, this.peer));
    for (const code of [...codes].reverse())
      this.sendKey(
        mapKeyEvent({ code, down: false, ...this.locks }, this.peer),
      );
  }

  setKeyboardMode(mode: KeyboardInputMode): void {
    if (mode === this.keyboardMode) return;
    this.releaseAll(); // nothing stays held across the switch
    this.keyboardMode = mode;
  }

  /** Type text on the peer as characters (soft keyboards, IME results). */
  sendText(text: string): void {
    if (!text) return;
    this.sendKey(textKeyEvent(text));
  }

  /** Move the remote pointer to a client point (gesture layers). */
  pointerMove(at: PointerAt): void {
    this.onPointerMove(at);
  }

  /** Press or release a button at a client point (DOM numbering: 0 left, 1 middle, 2 right). */
  pointerButton(at: PointerAt, down: boolean): void {
    this.onPointerButton({ button: 0, ...at }, down);
  }

  /** Scroll by pixel deltas, as a wheel would (positive dy scrolls down). */
  scroll(dx: number, dy: number): void {
    const n = this.wheel.push(dx, dy, 0);
    if (n) this.sendMouse(mouseEvent(mouseMask(MOUSE_TYPE.wheel), n.x, n.y));
  }

  sendCtrlAltDel(): void {
    this.sendKey(ctrlAltDelEvent(this.opts.peerPlatform));
  }

  /** Release everything held and remove all listeners. */
  detach(): void {
    this.releaseAll();
    this.abort.abort();
  }

  /** Key events held back after a paste shortcut, sent in order when the delay ends. */
  private keyQueue: KeyEvent[] | undefined;

  private queueOrSendKey(ev: KeyEvent, startHold: boolean): void {
    if (startHold && !this.keyQueue) {
      this.keyQueue = [];
      setTimeout(() => {
        const q = this.keyQueue ?? [];
        this.keyQueue = undefined;
        for (const k of q) this.sendKey(k);
      }, this.opts.pasteDelayMs ?? 50);
    }
    if (this.keyQueue) this.keyQueue.push(ev);
    else this.sendKey(ev);
  }

  private sendKey(ev: KeyEvent | undefined): void {
    if (!ev || !this.enabled) return;
    this.opts.send(
      create(MessageSchema, { union: { case: "keyEvent", value: ev } }),
    );
    this.opts.onSent?.("key", ev);
  }

  private sendMouse(ev: RdMouseEvent): void {
    if (!this.enabled) return;
    this.opts.send(
      create(MessageSchema, { union: { case: "mouseEvent", value: ev } }),
    );
    this.opts.onSent?.("mouse", ev);
  }

  private remote(e: { clientX: number; clientY: number }) {
    return toRemote(
      e.clientX,
      e.clientY,
      this.opts.element.getBoundingClientRect(),
      this.geometry,
    );
  }

  private onPointerMove(e: PointerAt): void {
    const p = this.remote(e);
    if (!p.inside && this.buttonsDown.size === 0) return;
    if (this.lastMove && this.lastMove.x === p.x && this.lastMove.y === p.y)
      return;
    this.lastMove = { x: p.x, y: p.y };
    this.sendMouse(mouseEvent(mouseMask(MOUSE_TYPE.move), p.x, p.y));
  }

  private onPointerButton(e: PointerAt, down: boolean): void {
    const button = rustdeskButton(e.button ?? 0);
    if (button === undefined) return;
    if (down) {
      this.opts.element.focus({ preventScroll: true });
      if ("pointerId" in e)
        this.opts.element.setPointerCapture?.((e as PointerEvent).pointerId);
      this.buttonsDown.add(button);
    } else if (!this.buttonsDown.delete(button)) {
      return; // a release we never saw the press of
    }
    if ("preventDefault" in e) (e as unknown as Event).preventDefault();
    const p = this.remote(e);
    // Upstream sends position with the click; a move first makes sure the peer's pointer is there.
    if (!this.lastMove || this.lastMove.x !== p.x || this.lastMove.y !== p.y) {
      this.lastMove = { x: p.x, y: p.y };
      this.sendMouse(mouseEvent(mouseMask(MOUSE_TYPE.move), p.x, p.y));
    }
    this.sendMouse(
      mouseEvent(
        mouseMask(down ? MOUSE_TYPE.down : MOUSE_TYPE.up, button),
        p.x,
        p.y,
        legacyModifiers({
          alt: e.altKey,
          ctrl: e.ctrlKey,
          shift: e.shiftKey,
          meta: e.metaKey,
        }),
      ),
    );
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const n = this.wheel.push(e.deltaX, e.deltaY, e.deltaMode);
    if (n)
      this.sendMouse(
        mouseEvent(
          mouseMask(MOUSE_TYPE.wheel),
          n.x,
          n.y,
          legacyModifiers({
            alt: e.altKey,
            ctrl: e.ctrlKey,
            shift: e.shiftKey,
            meta: e.metaKey,
          }),
        ),
      );
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.isComposing || !this.peer) return;
    this.locks = {
      capsLock: e.getModifierState("CapsLock"),
      numLock: e.getModifierState("NumLock"),
    };
    if (!down && this.textKeysDown.delete(e.code))
      return void e.preventDefault();
    if (!down && !this.keysDown.has(e.code)) return; // press happened before we had focus
    const k = {
      code: e.code,
      down,
      ...this.locks,
      alt: e.altKey,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      meta: e.metaKey,
    };
    let ev: KeyEvent | undefined;
    if (this.keyboardMode === "translate") {
      const t = translateKeyEvents(
        { ...k, key: e.key, altGraph: e.getModifierState("AltGraph") },
        this.peer,
      );
      if (t.text) {
        e.preventDefault();
        this.textKeysDown.add(e.code);
        return void this.queueOrSendKey(t.events[0]!, false);
      }
      ev = t.events[0];
      if (!ev && (e.key === "Dead" || e.key === "AltGraph")) e.preventDefault();
    } else ev = mapKeyEvent(k, this.peer);
    if (!ev) return;
    const paste = down && (this.opts.isPasteShortcut?.(e) ?? false);
    // A paste shortcut keeps its default action: that is what makes the browser fire `paste`.
    if (!paste) e.preventDefault();
    if (down) this.keysDown.add(e.code);
    else this.keysDown.delete(e.code);
    // Auto-repeat keydowns are sent as further downs, as the native client does.
    this.queueOrSendKey(ev, paste);
  }

  private releaseAll(): void {
    const q = this.keyQueue ?? [];
    this.keyQueue = undefined;
    for (const k of q) this.sendKey(k);
    if (this.peer)
      for (const code of [...this.keysDown].reverse())
        this.sendKey(
          mapKeyEvent({ code, down: false, ...this.locks }, this.peer),
        );
    this.keysDown.clear();
    this.textKeysDown.clear();
    const p = this.lastMove;
    for (const b of this.buttonsDown)
      this.sendMouse(
        mouseEvent(mouseMask(MOUSE_TYPE.up, b), p?.x ?? 0, p?.y ?? 0),
      );
    this.buttonsDown.clear();
  }
}
