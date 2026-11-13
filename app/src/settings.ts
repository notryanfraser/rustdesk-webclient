// Per-peer view settings and the app theme, in localStorage. Like recent.ts: storage can be
// unavailable (private windows, blocked site data), and the app then works with the defaults.
import type {
  ImageQualitySetting,
  KeyboardInputMode,
  QualityOptions,
} from "@rustdesk-web/core";

export type Scaling = "fit" | "original";
export type Theme = "auto" | "light" | "dark";

export interface PeerSettings {
  /** undefined: the peer's default (Balanced). */
  quality?: ImageQualitySetting;
  /** undefined: the peer's default cap (30 fps, video_qos.rs FPS). */
  fps?: number;
  scaling: Scaling;
  /** "map": keys by position (the remote's layout); "translate": characters (yours). */
  keyboard: KeyboardInputMode;
}

/** What the peer uses when we ask for nothing (rustdesk 1.5.3 video_qos.rs: Balanced, FPS = 30). */
export const PEER_DEFAULT_QUALITY: ImageQualitySetting = "balanced";
export const PEER_DEFAULT_FPS = 30;

const PEERS_KEY = "rustdesk-web.peer-settings";
const THEME_KEY = "rustdesk-web.theme";
const DEFAULTS: PeerSettings = { scaling: "fit", keyboard: "map" };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: the setting lasts for this page only
  }
}

const validQuality = (q: unknown): q is ImageQualitySetting =>
  q === "low" ||
  q === "balanced" ||
  q === "best" ||
  (typeof q === "object" &&
    q !== null &&
    typeof (q as { custom?: unknown }).custom === "number");

export function loadPeerSettings(peerId: string): PeerSettings {
  const all = read<Record<string, unknown>>(PEERS_KEY, {});
  const s = (all && typeof all === "object" ? all[peerId] : undefined) as
    Partial<PeerSettings> | undefined;
  return {
    quality: validQuality(s?.quality) ? s.quality : undefined,
    fps: typeof s?.fps === "number" && s.fps > 0 ? s.fps : undefined,
    scaling: s?.scaling === "original" ? "original" : DEFAULTS.scaling,
    keyboard: s?.keyboard === "translate" ? "translate" : DEFAULTS.keyboard,
  };
}

export function savePeerSettings(peerId: string, s: PeerSettings): void {
  const all = read<Record<string, PeerSettings>>(PEERS_KEY, {});
  write(PEERS_KEY, {
    ...(all && typeof all === "object" ? all : {}),
    [peerId]: s,
  });
}

/** Saved settings as login options: only what the user changed from the peer's defaults. */
export const loginQuality = (s: PeerSettings): QualityOptions => ({
  ...(s.quality !== undefined ? { quality: s.quality } : {}),
  ...(s.fps !== undefined ? { fps: s.fps } : {}),
});

export function loadTheme(): Theme {
  const t = read<unknown>(THEME_KEY, "auto");
  return t === "light" || t === "dark" ? t : "auto";
}

/** Apply (and remember) the theme: styles.css reads :root[data-theme]. */
export function applyTheme(t: Theme, remember = true): void {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
  if (remember) write(THEME_KEY, t);
}
