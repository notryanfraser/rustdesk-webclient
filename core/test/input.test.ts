// Input mapping: browser key codes -> peer-native codes (upstream rdev tables), lock-state
// modifiers, Pause and Ctrl+Alt+Del special cases, pointer -> remote coordinates, wheel notches.
// The live check (keys and clicks observed with xev on the peer) is e2e/input-run.mjs.
import { describe, expect, it } from "vitest";
import {
  CODE_TO_RDEV_KEY,
  ControlKey,
  KeyboardMode,
  MOUSE_BUTTON,
  MOUSE_TYPE,
  RDEV_KEY_CODES,
  WheelAccumulator,
  ctrlAltDelEvent,
  mapKeyEvent,
  mouseMask,
  peerKeyCode,
  peerKeyPlatform,
  rustdeskButton,
  toRemote,
  isCharacterKey,
  textKeyEvent,
  translateKeyEvents,
  type TranslateKey,
} from "../src/index.js";

describe("peerKeyPlatform", () => {
  it("normalises PeerInfo.platform like keyboard.rs get_peer_platform", () => {
    expect(peerKeyPlatform("Windows")).toBe("windows");
    expect(peerKeyPlatform("Linux")).toBe("linux");
    expect(peerKeyPlatform("Mac OS")).toBe("macos");
    expect(peerKeyPlatform("Android")).toBeUndefined();
  });
});

describe("keymap (generated from rdev 0904f23)", () => {
  it("has the expected size and covers every key a US keyboard produces", () => {
    expect(Object.keys(CODE_TO_RDEV_KEY).length).toBe(131);
    const us = [
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `Key${c}`),
      ..."0123456789".split("").map((d) => `Digit${d}`),
      "Backquote",
      "Minus",
      "Equal",
      "BracketLeft",
      "BracketRight",
      "Backslash",
      "Semicolon",
      "Quote",
      "Comma",
      "Period",
      "Slash",
      "Space",
      "Enter",
      "Tab",
      "Backspace",
      "Escape",
      "CapsLock",
      "ShiftLeft",
      "ShiftRight",
      "ControlLeft",
      "ControlRight",
      "AltLeft",
      "AltRight",
      "MetaLeft",
      "MetaRight",
      "ContextMenu",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Insert",
      "Delete",
      "PrintScreen",
      "ScrollLock",
      "NumLock",
      ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
      ..."0123456789".split("").map((d) => `Numpad${d}`),
      "NumpadAdd",
      "NumpadSubtract",
      "NumpadMultiply",
      "NumpadDivide",
      "NumpadDecimal",
      "NumpadEnter",
      "IntlBackslash",
    ];
    for (const peer of ["windows", "linux"] as const)
      for (const code of us)
        expect(peerKeyCode(code, peer), `${code} -> ${peer}`).toBeTypeOf(
          "number",
        );
  });

  it("matches upstream values per platform (spot checks)", () => {
    // [code, windows scancode, linux X11 keycode, macOS kVK]
    const rows: [string, number, number, number | undefined][] = [
      ["KeyA", 0x1e, 38, 0],
      ["KeyQ", 0x10, 24, 12],
      ["Digit1", 0x02, 10, 18],
      ["Enter", 0x1c, 36, 36],
      ["Space", 0x39, 65, 49],
      ["ArrowUp", 0xe048, 111, 126],
      ["ControlRight", 0xe01d, 105, 62],
      ["AltRight", 0xe038, 108, 61],
      ["MetaLeft", 0xe05b, 133, 55],
      ["NumpadEnter", 0xe01c, 104, 76],
      ["IntlBackslash", 0x56, 94, 10],
      ["PrintScreen", 0xe037, 107, undefined], // commented out in rdev macos.rs
    ];
    for (const [code, win, linux, mac] of rows) {
      expect(peerKeyCode(code, "windows"), code).toBe(win);
      expect(peerKeyCode(code, "linux"), code).toBe(linux);
      expect(peerKeyCode(code, "macos"), code).toBe(mac);
    }
    expect(RDEV_KEY_CODES.Pause).toEqual({ win: 0, linux: 127 });
  });
});

describe("mapKeyEvent (map mode)", () => {
  it("sends the peer-native code in chr, mode Map, no modifiers by default", () => {
    const e = mapKeyEvent({ code: "KeyA", down: true }, "linux")!;
    expect(e.mode).toBe(KeyboardMode.Map);
    expect(e.union).toEqual({ case: "chr", value: 38 });
    expect(e.down).toBe(true);
    expect(e.press).toBe(false);
    expect(e.modifiers).toEqual([]);
    expect(
      mapKeyEvent({ code: "KeyA", down: false }, "windows")!.union.value,
    ).toBe(0x1e);
  });

  it("modifiers carry lock state only: CapsLock on letter keys, NumLock on numpad keys", () => {
    const m = (code: string) =>
      mapKeyEvent(
        {
          code,
          down: true,
          capsLock: true,
          numLock: true,
          shift: true,
          ctrl: true,
        },
        "linux",
      )!.modifiers;
    expect(m("KeyZ")).toEqual([ControlKey.CapsLock]);
    expect(m("Comma")).toEqual([ControlKey.CapsLock]); // is_letter_rdev_key_ex
    expect(m("BracketLeft")).toEqual([ControlKey.CapsLock]);
    expect(m("Digit1")).toEqual([]);
    expect(m("Numpad5")).toEqual([ControlKey.NumLock]);
    expect(m("NumpadDecimal")).toEqual([ControlKey.NumLock]);
    expect(m("NumpadEnter")).toEqual([]); // not in is_numpad_rdev_key
    expect(m("ShiftLeft")).toEqual([]);
  });

  it("Pause: legacy ControlKey.Pause with held modifiers to Windows, X11 keycode 127 to Linux", () => {
    const w = mapKeyEvent(
      { code: "Pause", down: true, ctrl: true },
      "windows",
    )!;
    expect(w.mode).toBe(KeyboardMode.Legacy);
    expect(w.union).toEqual({ case: "controlKey", value: ControlKey.Pause });
    expect(w.modifiers).toEqual([ControlKey.Control]);
    expect(
      mapKeyEvent({ code: "Pause", down: true }, "linux")!.union.value,
    ).toBe(127);
    expect(mapKeyEvent({ code: "Pause", down: true }, "macos")).toBeUndefined();
  });

  it("unknown codes are not sent", () => {
    expect(mapKeyEvent({ code: "", down: true }, "linux")).toBeUndefined();
    expect(mapKeyEvent({ code: "Fn", down: true }, "linux")).toBeUndefined();
  });

  it("Ctrl+Alt+Del as the 1.5.3 native client sends it", () => {
    const w = ctrlAltDelEvent("Windows");
    expect(w.union).toEqual({
      case: "controlKey",
      value: ControlKey.CtrlAltDel,
    });
    expect([w.down, w.press, w.mode]).toEqual([
      true,
      false,
      KeyboardMode.Legacy,
    ]);
    const l = ctrlAltDelEvent("Linux");
    expect(l.union).toEqual({ case: "controlKey", value: ControlKey.Delete });
    expect([l.down, l.press]).toEqual([false, true]);
    expect(l.modifiers).toEqual([ControlKey.Alt, ControlKey.Control]);
  });
});

describe("mouse", () => {
  it("mask = type | button << 3, buttons from PointerEvent.button", () => {
    expect(mouseMask(MOUSE_TYPE.move)).toBe(0);
    expect(mouseMask(MOUSE_TYPE.down, MOUSE_BUTTON.left)).toBe(9); // 1 | 1<<3, as the 1.2.5 client
    expect(mouseMask(MOUSE_TYPE.up, MOUSE_BUTTON.right)).toBe(18);
    expect(mouseMask(MOUSE_TYPE.down, MOUSE_BUTTON.wheel)).toBe(33);
    expect(mouseMask(MOUSE_TYPE.wheel)).toBe(3);
    expect([0, 1, 2, 3, 4, 5].map(rustdeskButton)).toEqual([
      1,
      4,
      2,
      8,
      16,
      undefined,
    ]);
  });

  it("toRemote: contain-fit at two scale factors, letterbox, clamping, display origin", () => {
    const g = { x: 0, y: 0, width: 1920, height: 1080 };
    // Scale 0.5: 960x540 box at (10,20), no bars. Fractional points map exactly; an integer
    // point is a whole CSS pixel (2x2 remote px here) and maps through its centre.
    const half = { left: 10, top: 20, width: 960, height: 540 };
    expect(toRemote(10.25, 20.25, half, g)).toEqual({
      x: 0,
      y: 0,
      inside: true,
    });
    expect(toRemote(10, 20, half, g)).toEqual({ x: 1, y: 1, inside: true });
    expect(toRemote(10 + 480.25, 20 + 270.25, half, g)).toEqual({
      x: 960,
      y: 540,
      inside: true,
    });
    expect(toRemote(10 + 959.9, 20 + 539.9, half, g)).toEqual({
      x: 1919,
      y: 1079,
      inside: true,
    });
    expect(toRemote(10 + 959, 20 + 539, half, g)).toEqual({
      x: 1919,
      y: 1079,
      inside: true,
    });
    // Scale 1.25-ish with vertical bars: 2400x1200 box holds 2133.33x1200.
    const big = { left: 0, top: 0, width: 2400, height: 1200 };
    const s = 1200 / 1080;
    const bar = (2400 - 1920 * s) / 2;
    expect(toRemote(bar + 100.5 * s, 50.5 * s, big, g)).toEqual({
      x: 100,
      y: 50,
      inside: true,
    });
    expect(toRemote(bar - 5.1, 600.1, big, g)).toMatchObject({
      x: 0,
      inside: false,
    });
    expect(toRemote(2399, 600, big, g)).toMatchObject({
      x: 1919,
      inside: false,
    });
    // Scaled up 2x, integer points: every CSS px is half a remote px, no bias.
    const twice = { left: 0, top: 0, width: 3840, height: 2160 };
    expect(toRemote(201, 401, twice, g)).toEqual({
      x: 100,
      y: 200,
      inside: true,
    });
    // Second display at (1920, 0): coordinates are in the peer's desktop space.
    const right = { x: 1920, y: 0, width: 1280, height: 1024 };
    expect(
      toRemote(0, 0, { left: 0, top: 0, width: 1280, height: 1024 }, right),
    ).toEqual({
      x: 1920,
      y: 0,
      inside: true,
    });
  });

  it("toRemote with integer points (Firefox; any browser at 1x) maps through the pixel centre", () => {
    // For every remote column x: the browser reports trunc((x + 0.5) * scale) for a point on
    // it; how often does that map back to x? Left-edge mapping (the first version) gets 50% at
    // scale 5/6 and misses 25% even when scaled UP (1.25), where every px is reachable.
    const g = { x: 0, y: 0, width: 1920, height: 1080 };
    const rate = (scale: number) => {
      const box = {
        left: 0,
        top: 0,
        width: 1920 * scale,
        height: 1080 * scale,
      };
      let exact = 0;
      let max = 0;
      for (let x = 0; x < 1920; x++) {
        const err = toRemote(Math.trunc((x + 0.5) * scale), 10, box, g).x - x;
        if (err === 0) exact++;
        max = Math.max(max, Math.abs(err));
      }
      return { exact: exact / 1920, max };
    };
    expect(rate(1.25)).toEqual({ exact: 1, max: 0 }); // scaled up: always exact
    expect(rate(5 / 6).max).toBe(1); // scaled down: within the CSS-px quantisation...
    expect(rate(5 / 6).exact).toBeGreaterThan(0.8); // ...and exact 83% of the time
    expect(rate(2 / 3).max).toBe(1);
  });

  it("wheel: line mode one notch per event, pixel mode accumulated, sign as upstream", () => {
    const w = new WheelAccumulator();
    expect(w.push(0, 3, 1)).toEqual({ x: 0, y: -1 }); // Firefox wheel down
    expect(w.push(0, -3, 1)).toEqual({ x: 0, y: 1 });
    expect(w.push(0, 40, 0)).toBeUndefined(); // trackpad: accumulate
    expect(w.push(0, 40, 0)).toBeUndefined();
    expect(w.push(0, 40, 0)).toEqual({ x: 0, y: -1 }); // 120 px -> 1 notch, 20 left over
    expect(w.push(0, 200, 0)).toEqual({ x: 0, y: -2 }); // 220 -> 2 notches
    expect(w.push(120, 10, 0)).toEqual({ x: -1, y: 0 }); // horizontal dominant
    expect(w.push(0, 0, 0)).toBeUndefined();
  });
});

describe("translate mode", () => {
  const t = (
    k: Partial<TranslateKey> & { code: string; key: string },
    peer: "windows" | "linux" = "linux",
  ) => translateKeyEvents({ down: true, ...k }, peer);
  const seqOf = (r: ReturnType<typeof translateKeyEvents>) =>
    r.events.map((e) =>
      e.union.case === "seq"
        ? e.union.value
        : `${e.union.case}:${e.union.value}`,
    );

  it("sends the character the local layout produced, as text, press only", () => {
    // French AZERTY: the key at US "Q" types "a"; Shift+1 types "1"
    const r = t({ code: "KeyQ", key: "a" });
    expect(r.text).toBe(true);
    expect(seqOf(r)).toEqual(["a"]);
    expect(r.events[0]!.mode).toBe(KeyboardMode.Translate);
    expect(r.events[0]!.down).toBe(true);
    expect(seqOf(t({ code: "Digit1", key: "1", shift: true }))).toEqual(["1"]);
    expect(seqOf(t({ code: "BracketLeft", key: "é" }))).toEqual(["é"]); // dead key + e, composed
    expect(seqOf(t({ code: "Space", key: " " }))).toEqual([" "]);
  });

  it("dead keys and AltGr send nothing; AltGr characters are text", () => {
    expect(t({ code: "BracketLeft", key: "Dead" }).events).toEqual([]);
    expect(t({ code: "AltRight", key: "AltGraph" }).events).toEqual([]);
    // German: AltGr+Q = "@" (browsers report ctrl+alt with AltGraph state on Windows)
    expect(
      seqOf(
        t(
          { code: "KeyQ", key: "@", ctrl: true, alt: true, altGraph: true },
          "windows",
        ),
      ),
    ).toEqual(["@"]);
  });

  it("non-character keys, numpad and shortcuts go by position (chr), in Translate mode", () => {
    const peer = "linux";
    for (const k of [
      { code: "Enter", key: "Enter" },
      { code: "ArrowLeft", key: "ArrowLeft" },
      { code: "ShiftLeft", key: "Shift" },
      { code: "Numpad5", key: "5" },
      { code: "KeyC", key: "c", ctrl: true },
      { code: "KeyV", key: "v", meta: true },
    ]) {
      const r = t(k, peer);
      expect(r.text, k.code).toBe(false);
      expect(r.events[0]!.union.case, k.code).toBe("chr");
      expect(r.events[0]!.union.value, k.code).toBe(peerKeyCode(k.code, peer));
      expect(r.events[0]!.mode, k.code).toBe(KeyboardMode.Translate);
    }
  });

  it("releases of character keys are not text", () => {
    const r = translateKeyEvents(
      { code: "KeyQ", key: "a", down: false },
      "linux",
    );
    expect(r.text).toBe(false);
    expect(r.events[0]?.union.case).toBe("chr");
  });

  it("isCharacterKey tells characters from key names", () => {
    for (const c of ["a", "Ä", "ß", "ж", "€", "1", " ", "😀", "❤️"])
      expect(isCharacterKey(c), c).toBe(true);
    for (const n of [
      "Enter",
      "F1",
      "Shift",
      "Dead",
      "Unidentified",
      "Process",
      "",
      "\t",
    ])
      expect(isCharacterKey(n), n).toBe(false);
  });

  it("textKeyEvent carries soft-keyboard text", () => {
    const e = textKeyEvent("hello wörld");
    expect(e.union).toEqual({ case: "seq", value: "hello wörld" });
    expect(e.mode).toBe(KeyboardMode.Translate);
  });
});
