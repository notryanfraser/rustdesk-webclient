// Touch gestures on the remote screen. The InputController leaves touch pointers to this
// layer (touch: "app") and is driven through pointerMove / pointerButton / scroll:
// tap left click where tapped (two taps: a double click)
// long press (500 ms) right click
// drag left-button drag (press where the finger went down)
// two-finger tap right click
// two fingers, zoomed pinch zooms the view, moving pans it
// two fingers, not pinch zooms in; a two-finger drag scrolls the remote (wheel)
// Trackpad mode (setMode) works on a local cursor instead, wherever the finger is:
// one-finger drag moves the cursor (relative, with a little acceleration)
// tap / long press / two-finger tap left / right / right click at the cursor (two taps: double)
// tap, then touch and drag left-button drag (press at the cursor, it follows the finger)
// two fingers a drag scrolls the remote even when zoomed; pinch still zooms
// Zoom is a CSS transform on the canvas; getBoundingClientRect() includes it, so the
// controller's coordinate mapping stays exact.
import type { InputController } from "@rustdesk-web/core";
import type { PointerMode } from "./settings";

const TAP_SLOP_PX = 10;
const LONG_PRESS_MS = 500;
const TWO_FINGER_TAP_MS = 250;
const MAX_SCALE = 5;
/** Trackpad: a touch this soon after a tap is a double tap, or the start of a drag. */
const DOUBLE_TAP_MS = 300;
/** Trackpad: zoomed, the view pans when the cursor comes this close to its edge. */
const CURSOR_MARGIN_PX = 24;
/** Trackpad acceleration: finger speed (px/ms) above ACCEL_FROM adds gain, up to MAX_GAIN. */
const ACCEL_FROM = 0.4;
const MAX_GAIN = 3;

const CURSOR_SVG =
  '<svg width="20" height="28" viewBox="0 0 20 28" aria-hidden="true">' +
  '<path d="M1 1v21l5.5-5 4 9.5 3.5-1.5-4-9H18z" fill="#fff" stroke="#000" ' +
  'stroke-width="1.6" stroke-linejoin="round"/></svg>';

type Pt = { x: number; y: number };

export class TouchGestures {
  private readonly touches = new Map<number, Pt>();
  private start: (Pt & { t: number }) | undefined;
  private dragging = false;
  private longPressed = false;
  private longTimer: ReturnType<typeof setTimeout> | undefined;
  private two:
    | {
        dist: number;
        mid: Pt;
        lastMid: Pt;
        t: number;
        moved: boolean;
        scale: number;
        tx: number;
        ty: number;
      }
    | undefined;
  /** Set when a second finger landed: the rest of the gesture is not a click or drag. */
  private multi = false;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private readonly abort = new AbortController();
  // Trackpad mode. The cursor is kept as a fraction of the canvas (0..1), so it stays on the same
  // remote pixel through zoom, pan, resize and rotation.
  private cursor = { u: 0.5, v: 0.5 };
  private cursorEl: HTMLElement | undefined;
  /** Last finger sample of a cursor move. */
  private last: (Pt & { t: number }) | undefined;
  /** The finger left the tap slop: this touch moves the cursor and is no click. */
  private moving = false;
  /** This touch followed a tap closely: moving it drags with the left button. */
  private dragArmed = false;
  private lastTapAt: number | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly input: () => InputController | undefined,
    private readonly onZoom?: (scale: number) => void,
    private mode: PointerMode = "touch",
  ) {
    const on = <K extends keyof HTMLElementEventMap>(
      t: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => canvas.addEventListener(t, fn, { signal: this.abort.signal });
    on("pointerdown", (e) => e.pointerType === "touch" && this.down(e));
    on("pointermove", (e) => e.pointerType === "touch" && this.move(e));
    on("pointerup", (e) => e.pointerType === "touch" && this.up(e));
    on("pointercancel", (e) => e.pointerType === "touch" && this.up(e, true));
    canvas.style.transformOrigin = "0 0";
    window.addEventListener("resize", () => this.placeCursor(), {
      signal: this.abort.signal,
    });
    // A scrolling box ("original size") moves the canvas under a still cursor element.
    canvas.parentElement?.addEventListener("scroll", () => this.placeCursor(), {
      signal: this.abort.signal,
    });
    if (mode === "trackpad") this.showCursor();
  }

  detach(): void {
    this.abort.abort();
    this.hideCursor();
    this.resetZoom();
  }

  setMode(mode: PointerMode): void {
    if (mode === this.mode) return;
    this.cancelSingle(); // release a button held by the old mode
    this.mode = mode;
    this.lastTapAt = undefined;
    if (mode === "trackpad") this.showCursor();
    else this.hideCursor();
  }

  resetZoom(): void {
    this.scale = 1;
    this.tx = this.ty = 0;
    this.apply();
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 1) {
      this.multi = false;
      this.dragging = false;
      this.longPressed = false;
      this.moving = false;
      this.dragArmed =
        this.mode === "trackpad" &&
        this.lastTapAt !== undefined &&
        e.timeStamp - this.lastTapAt < DOUBLE_TAP_MS;
      this.lastTapAt = undefined;
      this.start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      this.longTimer = setTimeout(() => {
        if (!this.start || this.multi || this.dragging) return;
        this.longPressed = true;
        this.click(this.target(this.start), 2);
      }, LONG_PRESS_MS);
    } else if (this.touches.size === 2) {
      this.cancelSingle();
      this.lastTapAt = undefined;
      this.multi = true;
      const [a, b] = [...this.touches.values()] as [Pt, Pt];
      this.two = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        lastMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        t: e.timeStamp,
        moved: false,
        scale: this.scale,
        tx: this.tx,
        ty: this.ty,
      };
    }
  }

  private move(e: PointerEvent): void {
    const p = this.touches.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    p.x = e.clientX;
    p.y = e.clientY;
    const input = this.input();
    if (this.touches.size === 1 && !this.multi && this.start) {
      if (this.mode === "trackpad") {
        this.trackpadMove(e, p);
        return;
      }
      if (
        !this.dragging &&
        Math.hypot(p.x - this.start.x, p.y - this.start.y) > TAP_SLOP_PX
      ) {
        if (this.longPressed) return; // the right click already happened
        clearTimeout(this.longTimer);
        this.dragging = true;
        input?.pointerMove({ clientX: this.start.x, clientY: this.start.y });
        input?.pointerButton(
          { clientX: this.start.x, clientY: this.start.y, button: 0 },
          true,
        );
      }
      if (this.dragging) input?.pointerMove({ clientX: p.x, clientY: p.y });
      return;
    }
    if (this.touches.size === 2 && this.two) {
      const [a, b] = [...this.touches.values()] as [Pt, Pt];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ratio = dist / (this.two.dist || 1);
      if (
        Math.abs(ratio - 1) > 0.05 ||
        Math.hypot(mid.x - this.two.mid.x, mid.y - this.two.mid.y) > TAP_SLOP_PX
      )
        this.two.moved = true;
      const pinching = Math.abs(ratio - 1) > 0.08;
      const last = this.two.lastMid;
      this.two.lastMid = mid;
      if ((this.scale === 1 || this.mode === "trackpad") && !pinching) {
        // Not zoomed (or in trackpad mode, zoomed or not): a two-finger drag scrolls the remote,
        // like a trackpad (fingers up = scroll down, as on a phone).
        input?.scroll(last.x - mid.x, last.y - mid.y);
        return;
      }
      // Zoom about the gesture's start midpoint, and pan with the midpoint.
      const scale = Math.min(MAX_SCALE, Math.max(1, this.two.scale * ratio));
      const k = scale / this.two.scale;
      const box = this.canvas.parentElement?.getBoundingClientRect();
      const ox = this.two.mid.x - (box?.left ?? 0);
      const oy = this.two.mid.y - (box?.top ?? 0);
      this.scale = scale;
      this.tx = ox - (ox - this.two.tx) * k + (mid.x - this.two.mid.x);
      this.ty = oy - (oy - this.two.ty) * k + (mid.y - this.two.mid.y);
      this.clamp();
      this.apply();
    }
  }

  private up(e: PointerEvent, cancelled = false): void {
    if (!this.touches.delete(e.pointerId)) return;
    e.preventDefault();
    const input = this.input();
    if (this.two && this.touches.size === 1) {
      // Two-finger tap: both fingers down briefly, hardly moved.
      if (
        !cancelled &&
        !this.two.moved &&
        e.timeStamp - this.two.t < TWO_FINGER_TAP_MS
      )
        this.click(this.target(this.two.mid), 2);
      this.two = undefined;
      return;
    }
    if (this.touches.size > 0) return;
    clearTimeout(this.longTimer);
    const s = this.start;
    this.start = undefined;
    if (this.multi || !s) return;
    if (this.dragging) {
      this.dragging = false;
      const at = this.target({ x: e.clientX, y: e.clientY });
      input?.pointerButton({ clientX: at.x, clientY: at.y, button: 0 }, false);
      return;
    }
    if (this.mode === "trackpad") {
      // A tap anywhere clicks at the cursor; a touch that moved it is no click.
      if (cancelled || this.longPressed || this.moving) return;
      this.click(this.target(s), 0);
      this.lastTapAt = e.timeStamp;
      return;
    }
    if (!cancelled && !this.longPressed) this.click(s, 0);
  }

  /** Trackpad: one finger moves the cursor, or drags with the left button after a double tap. */
  private trackpadMove(e: PointerEvent, p: Pt): void {
    const start = this.start!;
    if (this.longPressed) return; // the right click already happened
    if (!this.moving) {
      if (Math.hypot(p.x - start.x, p.y - start.y) <= TAP_SLOP_PX) return;
      clearTimeout(this.longTimer);
      this.moving = true;
      this.last = { x: start.x, y: start.y, t: start.t };
      if (this.dragArmed) {
        this.dragging = true;
        const at = this.cursorClient();
        const input = this.input();
        input?.pointerMove({ clientX: at.x, clientY: at.y });
        input?.pointerButton({ clientX: at.x, clientY: at.y, button: 0 }, true);
      }
    }
    const last = this.last!;
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    // Acceleration: above ACCEL_FROM px/ms every extra px/ms adds a full unit of gain.
    const speed = Math.hypot(dx, dy) / Math.max(1, e.timeStamp - last.t);
    const gain = Math.min(MAX_GAIN, 1 + Math.max(0, speed - ACCEL_FROM));
    this.last = { x: p.x, y: p.y, t: e.timeStamp };
    this.moveCursor(dx * gain, dy * gain);
  }

  private click(at: Pt, button: number): void {
    const input = this.input();
    const p = { clientX: at.x, clientY: at.y, button };
    input?.pointerMove(p);
    input?.pointerButton(p, true);
    input?.pointerButton(p, false);
  }

  private cancelSingle(): void {
    clearTimeout(this.longTimer);
    if (this.dragging && this.start) {
      this.dragging = false;
      const last = this.target([...this.touches.values()][0] ?? this.start);
      this.input()?.pointerButton(
        { clientX: last.x, clientY: last.y, button: 0 },
        false,
      );
    }
  }

  /** Where a click goes: the cursor in trackpad mode, else where the finger is. */
  private target(finger: Pt): Pt {
    return this.mode === "trackpad" ? this.cursorClient() : finger;
  }

  private cursorClient(): Pt {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.left + this.cursor.u * r.width,
      y: r.top + this.cursor.v * r.height,
    };
  }

  /** Move the cursor by a client-pixel delta, keep it in view, and tell the remote. */
  private moveCursor(dx: number, dy: number): void {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.cursor.u = Math.min(1, Math.max(0, this.cursor.u + dx / r.width));
    this.cursor.v = Math.min(1, Math.max(0, this.cursor.v + dy / r.height));
    if (this.scale > 1) this.panToCursor();
    this.placeCursor();
    const at = this.cursorClient();
    this.input()?.pointerMove({ clientX: at.x, clientY: at.y });
  }

  /** Zoomed: shift the view so the cursor stays CURSOR_MARGIN_PX inside the visible box. */
  private panToCursor(): void {
    const box = this.canvas.parentElement?.getBoundingClientRect();
    if (!box) return;
    const at = this.cursorClient();
    const m = Math.min(CURSOR_MARGIN_PX, box.width / 2, box.height / 2);
    this.tx +=
      Math.max(0, box.left + m - at.x) - Math.max(0, at.x - (box.right - m));
    this.ty +=
      Math.max(0, box.top + m - at.y) - Math.max(0, at.y - (box.bottom - m));
    this.clamp();
    this.apply();
  }

  private showCursor(): void {
    const box = this.canvas.parentElement;
    if (!box || this.cursorEl) return;
    const el = document.createElement("div");
    el.className = "trackpad-cursor";
    el.innerHTML = CURSOR_SVG;
    box.appendChild(el);
    this.cursorEl = el;
    this.placeCursor();
  }

  private hideCursor(): void {
    this.cursorEl?.remove();
    this.cursorEl = undefined;
  }

  /** Put the cursor element over its remote pixel; hidden when that is outside the visible box. */
  private placeCursor(): void {
    const el = this.cursorEl;
    const box = this.canvas.parentElement?.getBoundingClientRect();
    if (!el || !box) return;
    const at = this.cursorClient();
    const inside =
      at.x >= box.left &&
      at.x <= box.right &&
      at.y >= box.top &&
      at.y <= box.bottom;
    el.style.visibility = inside ? "visible" : "hidden";
    el.style.transform = `translate(${at.x}px, ${at.y}px)`;
  }

  /** Keep the zoomed canvas covering its box (no empty margins pulled into view). */
  private clamp(): void {
    const box = this.canvas.parentElement;
    if (!box) return;
    const w = box.clientWidth;
    const h = box.clientHeight;
    this.tx = Math.min(0, Math.max(w - w * this.scale, this.tx));
    this.ty = Math.min(0, Math.max(h - h * this.scale, this.ty));
  }

  private apply(): void {
    this.canvas.style.transform =
      this.scale === 1
        ? ""
        : `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.placeCursor();
    this.onZoom?.(this.scale);
  }
}
