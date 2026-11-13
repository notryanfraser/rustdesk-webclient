// Keyboard input, map mode: browser KeyboardEvent.code -> KeyEvent{mode: Map, chr}.
// Pure functions; no DOM. The DOM wiring is InputController (controller.ts).
//
// What a peer does with it (rustdesk 1.5.3 src/server/input_service.rs):
// * Map mode (map_keyboard_mode 1723-1734) presses the key at chr as a NATIVE code of the
// peer's platform: Windows scancode, Linux X11 keycode, macOS virtual keycode
// (sim_rdev_rawkey_position 1621-1641). The controller converts; the peer does not.
// * The native controller converts from its own platform's code (src/keyboard.rs
// _map_keyboard_mode 1350-1415); mobile clients start from the USB HID usage. A browser
// starts from KeyboardEvent.code, which rdev also tables (keycodes/chrome.rs); the joined
// tables are keymap.gen.ts (scripts/gen-keymap.mjs).
// * modifiers carries ONLY lock state in map mode (keyboard.rs event_to_key_events 998-1046,
// parse_add_lock_modes_modifiers 929-947): CapsLock on "letter" keys, NumLock on numpad keys.
// The peer forces its own lock state to match (LockModesHandler::new 201-...), so leaving
// CapsLock out while it is on would switch the peer's Caps Lock off. Ctrl/Shift/Alt/Meta are
// sent as their own key events.
// * Pause has no usable scancode on Windows; upstream sends it to Windows peers as a legacy
// ControlKey.Pause with the held modifiers (keyboard.rs windows_peer_special_key 1315-1347).
// rdev's browser table maps Pause to "" (no code), so "Pause" is added here by hand.
// Known gap (documented): macOS peers with an ISO keyboard
// (upstream swaps two keys when the local config says ISO).
//
// Translate mode, for a local layout that differs from the peer's, and for text from soft
// keyboards / IMEs: characters are sent as text, other keys as in map mode. Native controller:
// src/keyboard.rs translate_keyboard_mode 1517-1586 (try_fill_unicode 1419-1445); peer:
// src/server/input_service.rs translate_keyboard_mode 2262-2385:
// * a key that produces a character -> KeyEvent{mode: Translate, seq: the character, down: true},
// on the press only (no release is sent for it). The peer releases Shift and types the
// character itself (Windows: simulate_unicode; X11: key_click(Key::Layout); macOS:
// key_sequence), so the result does not depend on the peer's layout. The browser's
// KeyboardEvent.key already holds that character, after the local layout and dead keys.
// * a dead key sends nothing (its character comes with the next key); AltGr is not sent (else
// the peer sees Ctrl+Alt); numpad keys and keys without a character (Enter, arrows, F1,
// modifiers...) go as in map mode (chr = the peer's native code; Translate mode treats it the
// same: translate_process_code / sim_rdev_rawkey_position);
// * with Ctrl or Meta held (a shortcut, not text) the key goes by position, so Ctrl+C is Ctrl+C
// whatever the layouts. (The native client only does this for Windows->Linux, via
// get_char_from_vk; by position is what a browser can do everywhere.)

import { create } from "@bufbuild/protobuf";
import { ControlKey, KeyEventSchema, KeyboardMode } from "../gen/message_pb.js";
import type { KeyEvent } from "../gen/message_pb.js";
import { CODE_TO_RDEV_KEY, RDEV_KEY_CODES } from "./keymap.gen.js";

export type PeerKeyPlatform = "windows" | "linux" | "macos";

/** PeerInfo.platform ("Windows", "Linux", "Mac OS", ...) -> key table, or undefined if unsupported. */
export function peerKeyPlatform(platform: string): PeerKeyPlatform | undefined {
  // keyboard.rs get_peer_platform / OS_LOWER_*: lower-cased, whitespace removed.
  switch (platform.replace(/\s/g, "").toLowerCase()) {
    case "windows":
      return "windows";
    case "linux":
      return "linux";
    case "macos":
      return "macos";
    default:
      return undefined; // Android/iOS peers need other tables (not)
  }
}

/** The parts of a KeyboardEvent the mapping needs (so it can be tested without a DOM). */
export interface BrowserKey {
  code: string;
  down: boolean;
  /** getModifierState("CapsLock") / ("NumLock") at the time of the event. */
  capsLock?: boolean;
  numLock?: boolean;
  /** Held modifiers; only used for the legacy Pause event to Windows peers. */
  alt?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

const LETTER_KEYS = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `Key${c}`),
  // keyboard.rs is_letter_rdev_key_ex
  "LeftBracket",
  "RightBracket",
  "SemiColon",
  "Quote",
  "Comma",
  "Dot",
]);
const NUMPAD_KEYS = new Set([
  ..."0123456789".split("").map((d) => `Kp${d}`),
  "KpMinus",
  "KpMultiply",
  "KpDivide",
  "KpPlus",
  "KpDecimal",
]);
const FIELD: Record<PeerKeyPlatform, "win" | "linux" | "mac"> = {
  windows: "win",
  linux: "linux",
  macos: "mac",
};

/** rdev Key name for a KeyboardEvent.code, or undefined if rdev has none. */
export function rdevKeyForCode(code: string): string | undefined {
  if (code === "Pause") return "Pause";
  return CODE_TO_RDEV_KEY[code];
}

/** Native code the peer would press for this browser key, or undefined if unmappable. */
export function peerKeyCode(
  code: string,
  peer: PeerKeyPlatform,
): number | undefined {
  const key = rdevKeyForCode(code);
  return key === undefined ? undefined : RDEV_KEY_CODES[key]?.[FIELD[peer]];
}

/** Legacy modifier list, as upstream's legacy_modifiers / the 1.2.5 getMod build it. */
export function legacyModifiers(k: {
  alt?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}): ControlKey[] {
  const m: ControlKey[] = [];
  if (k.alt) m.push(ControlKey.Alt);
  if (k.ctrl) m.push(ControlKey.Control);
  if (k.shift) m.push(ControlKey.Shift);
  if (k.meta) m.push(ControlKey.Meta);
  return m;
}

/** KeyEvent for one browser key transition, or undefined when it cannot be sent to this peer. */
export function mapKeyEvent(
  k: BrowserKey,
  peer: PeerKeyPlatform,
): KeyEvent | undefined {
  const key = rdevKeyForCode(k.code);
  if (key === undefined) return undefined;
  if (key === "Pause" && peer === "windows") {
    return create(KeyEventSchema, {
      down: k.down,
      mode: KeyboardMode.Legacy,
      union: { case: "controlKey", value: ControlKey.Pause },
      modifiers: legacyModifiers(k),
    });
  }
  const chr = RDEV_KEY_CODES[key]?.[FIELD[peer]];
  if (chr === undefined) return undefined;
  const modifiers: ControlKey[] = [];
  if (k.capsLock && LETTER_KEYS.has(key)) modifiers.push(ControlKey.CapsLock);
  if (k.numLock && NUMPAD_KEYS.has(key)) modifiers.push(ControlKey.NumLock);
  return create(KeyEventSchema, {
    down: k.down,
    mode: KeyboardMode.Map,
    union: { case: "chr", value: chr },
    modifiers,
  });
}

/** A KeyboardEvent.key that types a character (not "Enter", "Shift", "Dead", "Unidentified"...). */
export function isCharacterKey(key: string): boolean {
  // Named keys are ASCII words; a character is one code point (or a short grapheme, e.g. an
  // emoji with a variation selector) that is not a control character.
  if (key.length === 0 || [...key].length > 2) return false;
  if ([...key].length === 2 && !/\p{M}|\uFE0F/u.test([...key][1]!))
    return false;
  return !/^\p{Cc}$/u.test(key[0]!);
}

/** A translate-mode text event: the peer types `text` as characters (see above). */
export function textKeyEvent(text: string): KeyEvent {
  return create(KeyEventSchema, {
    down: true,
    mode: KeyboardMode.Translate,
    union: { case: "seq", value: text },
  });
}

export interface TranslateKey extends BrowserKey {
  /** KeyboardEvent.key: the character after the local layout, or a key name. */
  key: string;
  /** getModifierState("AltGraph"). */
  altGraph?: boolean;
}

/**
 * Translate-mode events for one browser key transition. `text`: the key was sent as text (a
 * press only); the caller must then not send its release. Empty when nothing is sent.
 */
export function translateKeyEvents(
  k: TranslateKey,
  peer: PeerKeyPlatform,
): { events: KeyEvent[]; text: boolean } {
  const none = { events: [], text: false };
  if (k.key === "Dead" || k.key === "AltGraph") return none;
  const key = rdevKeyForCode(k.code);
  const shortcut = (k.ctrl || k.meta) && !k.altGraph;
  if (
    k.down &&
    !shortcut &&
    !(key !== undefined && NUMPAD_KEYS.has(key)) &&
    isCharacterKey(k.key)
  )
    return { events: [textKeyEvent(k.key)], text: true };
  const ev = mapKeyEvent(k, peer);
  if (!ev) return none;
  if (ev.mode === KeyboardMode.Map) ev.mode = KeyboardMode.Translate;
  return { events: [ev], text: false };
}

/**
 * Ctrl+Alt+Del as the 1.5.3 native client builds it (src/keyboard.rs event_ctrl_alt_del
 * 487-499): to Windows peers ControlKey.CtrlAltDel, down (the peer runs SendSAS,
 * input_service.rs is_function_key 2132-2148); to others a Delete *press* (down + up) with
 * Alt+Control. Legacy mode. (The 1.2.5 web client sent only a down for the latter.)
 */
export function ctrlAltDelEvent(platform: string): KeyEvent {
  if (peerKeyPlatform(platform) === "windows")
    return create(KeyEventSchema, {
      down: true,
      mode: KeyboardMode.Legacy,
      union: { case: "controlKey", value: ControlKey.CtrlAltDel },
    });
  return create(KeyEventSchema, {
    press: true,
    mode: KeyboardMode.Legacy,
    union: { case: "controlKey", value: ControlKey.Delete },
    modifiers: legacyModifiers({ alt: true, ctrl: true }),
  });
}
