// Mouse input: pointer position -> remote coordinates, buttons -> MouseEvent.mask, wheel.
// Pure functions; no DOM. The DOM wiring is InputController (controller.ts).
//
// Wire format (rustdesk 1.5.3 src/common.rs input 67-92, src/server/input_service.rs
// handle_mouse_simulation_ 1279-1470):
// * mask = type | (button << 3). Types: move 0, down 1, up 2, wheel 3 (trackpad 4, relative
// move 5: not used). Buttons: left 0x01, right 0x02, wheel/middle 0x04, back 0x08,
// forward 0x10.
// * Move: x, y are ABSOLUTE in the peer's desktop coordinate space; the peer calls
// mouse_move_to(x, y). For display d that is d.x + column, d.y + row.
// * Wheel: x, y are notches. The Flutter client sends one notch per scroll event on the
// dominant axis, with the sign flipped (scrolling down, deltaY > 0, sends y = -1;
// flutter/lib/models/input_model.dart onPointerSignalImage 1975-2021). The peer
// multiplies by WHEEL_DELTA (120) on Windows and negates y elsewhere.
// * modifiers (ControlKey list) apply on button down: the peer presses any listed modifier
// that is not already down and releases it after the click.

import { create } from "@bufbuild/protobuf";
import { MouseEventSchema } from "../gen/message_pb.js";
import type {
  ControlKey,
  MouseEvent as RdMouseEvent,
} from "../gen/message_pb.js";

export const MOUSE_TYPE = { move: 0, down: 1, up: 2, wheel: 3 } as const;
export const MOUSE_BUTTON = {
  left: 0x01,
  right: 0x02,
  wheel: 0x04,
  back: 0x08,
  forward: 0x10,
} as const;

/** PointerEvent.button (0 main, 1 aux, 2 secondary, 3 back, 4 forward) -> RustDesk button. */
export function rustdeskButton(button: number): number | undefined {
  return [
    MOUSE_BUTTON.left,
    MOUSE_BUTTON.wheel,
    MOUSE_BUTTON.right,
    MOUSE_BUTTON.back,
    MOUSE_BUTTON.forward,
  ][button];
}

export function mouseMask(type: number, button = 0): number {
  return type | (button << 3);
}

export function mouseEvent(
  mask: number,
  x = 0,
  y = 0,
  modifiers: ControlKey[] = [],
): RdMouseEvent {
  return create(MouseEventSchema, { mask, x, y, modifiers });
}

/** Where the remote display is drawn: the element's box (CSS px) and how it is fitted. */
export interface ViewBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The display being shown: its origin in the peer's desktop and its size in remote pixels. */
export interface RemoteGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Client point (CSS px, e.g. PointerEvent.clientX/Y) -> peer desktop coordinates, for a
 * display drawn into `box` with `object-fit: contain` (scaled uniformly, centred, letterboxed).
 * `inside` is false over the letterbox bars; the point is then clamped to the display edge.
 */
export function toRemote(
  clientX: number,
  clientY: number,
  box: ViewBox,
  g: RemoteGeometry,
): { x: number; y: number; inside: boolean } {
  const scale = Math.min(box.width / g.width, box.height / g.height);
  const offX = (box.width - g.width * scale) / 2;
  const offY = (box.height - g.height * scale) / 2;
  // An integer coordinate names a whole CSS pixel (Firefox always reports integers; so do most
  // browsers for a real mouse at 1x): use its centre. When the view is scaled down one CSS px
  // spans several remote px, and the left edge would bias every click up-left by up to one.
  const px = Number.isInteger(clientX) ? clientX + 0.5 : clientX;
  const py = Number.isInteger(clientY) ? clientY + 0.5 : clientY;
  const lx = (px - box.left - offX) / scale;
  const ly = (py - box.top - offY) / scale;
  const inside = lx >= 0 && ly >= 0 && lx < g.width && ly < g.height;
  const cx = Math.min(Math.max(Math.floor(lx), 0), g.width - 1);
  const cy = Math.min(Math.max(Math.floor(ly), 0), g.height - 1);
  return { x: g.x + cx, y: g.y + cy, inside };
}

/**
 * Wheel events -> notches. Line/page-mode events (Firefox's mouse wheel) are one notch each,
 * like upstream. Pixel-mode deltas (Chrome; every browser on a trackpad) arrive as many small
 * events, so they are accumulated and one notch is sent per PIXELS_PER_NOTCH, a deliberate
 * difference from upstream's one-notch-per-event, which would scroll a trackpad gesture by
 * dozens of notches. Dominant axis only; sign as upstream (down/right -> negative).
 */
export class WheelAccumulator {
  static readonly PIXELS_PER_NOTCH = 100;
  private accX = 0;
  private accY = 0;

  /** deltaMode: 0 pixel, 1 line, 2 page (WheelEvent). Returns notches to send, if any. */
  push(
    deltaX: number,
    deltaY: number,
    deltaMode: number,
  ): { x: number; y: number } | undefined {
    const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
    const d = horizontal ? deltaX : deltaY;
    if (d === 0) return undefined;
    let notches: number;
    if (deltaMode !== 0) {
      notches = Math.sign(d);
    } else {
      if (horizontal) this.accX += d;
      else this.accY += d;
      const acc = horizontal ? this.accX : this.accY;
      notches = Math.trunc(acc / WheelAccumulator.PIXELS_PER_NOTCH);
      if (notches === 0) return undefined;
      if (horizontal) this.accX -= notches * WheelAccumulator.PIXELS_PER_NOTCH;
      else this.accY -= notches * WheelAccumulator.PIXELS_PER_NOTCH;
    }
    // Moving on one axis drops what was accumulated on the other.
    if (horizontal) this.accY = 0;
    else this.accX = 0;
    return horizontal ? { x: -notches, y: 0 } : { x: 0, y: -notches };
  }
}
