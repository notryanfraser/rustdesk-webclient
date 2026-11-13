// Touch gestures on the remote screen. The InputController leaves touch pointers to this
// layer (touch: "app") and is driven through pointerMove / pointerButton / scroll:
// tap left click where tapped (two taps: a double click)
// long press (500 ms) right click
// drag left-button drag (press where the finger went down)
// two-finger tap right click
// two fingers, zoomed pinch zooms the view, moving pans it
// two fingers, not pinch zooms in; a two-finger drag scrolls the remote (wheel)
// Zoom is a CSS transform on the canvas; getBoundingClientRect() includes it, so the
// controller's coordinate mapping stays exact.
import type { InputController } from "@rustdesk-web/core";

const TAP_SLOP_PX = 10;
const LONG_PRESS_MS = 500;
const TWO_FINGER_TAP_MS = 250;
const MAX_SCALE = 5;

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

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly input: () => InputController | undefined,
    private readonly onZoom?: (scale: number) => void,
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
  }

  detach(): void {
    this.abort.abort();
    this.resetZoom();
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
      this.start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      this.longTimer = setTimeout(() => {
        if (!this.start || this.multi || this.dragging) return;
        this.longPressed = true;
        this.click(this.start, 2);
      }, LONG_PRESS_MS);
    } else if (this.touches.size === 2) {
      this.cancelSingle();
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
      if (this.scale === 1 && !pinching) {
        // Not zoomed: a two-finger drag scrolls the remote, like a trackpad (fingers up = scroll
        // down, as on a phone).
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
        this.click(this.two.mid, 2);
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
      input?.pointerButton(
        { clientX: e.clientX, clientY: e.clientY, button: 0 },
        false,
      );
      return;
    }
    if (!cancelled && !this.longPressed) this.click(s, 0);
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
      const last = [...this.touches.values()][0] ?? this.start;
      this.input()?.pointerButton(
        { clientX: last.x, clientY: last.y, button: 0 },
        false,
      );
    }
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
    this.onZoom?.(this.scale);
  }
}
