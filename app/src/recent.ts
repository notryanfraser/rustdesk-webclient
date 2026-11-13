// Saved remotes, newest first, in localStorage: ID, optional name, platform and last-connected time.
// Passwords are never stored.
// Storage can be unavailable (private windows, blocked site data); the app then works without it.
export interface RecentPeer {
  id: string;
  /** Last successful connection, ms since epoch. */
  at: number;
  /** Chosen by the user; absent on entries saved before names existed. */
  name?: string;
  /** Reported by the remote at login (e.g. "Windows"). */
  platform?: string;
}

const KEY = "rustdesk-web.recent-peers";
const REMEMBER_KEY = "rustdesk-web.remember-peers";
// Owned by settings.ts; forgetting a remote must also drop its entry there.
const PEER_SETTINGS_KEY = "rustdesk-web.peer-settings";
const MAX = 8;

/** Whether future connections are saved. On unless the user turned it off. */
export function loadRemember(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveRemember(on: boolean) {
  try {
    localStorage.setItem(REMEMBER_KEY, on ? "1" : "0");
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}

function dropPeerSettings(ids: string[]) {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(PEER_SETTINGS_KEY) ?? "{}",
    );
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const all = raw as Record<string, unknown>;
    if (!ids.some((id) => id in all)) return;
    for (const id of ids) delete all[id];
    localStorage.setItem(PEER_SETTINGS_KEY, JSON.stringify(all));
  } catch {
    // unreadable or unavailable: nothing to remove
  }
}

export function loadRecent(): RecentPeer[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v)
      ? v
          .filter(
            (p): p is RecentPeer =>
              typeof p?.id === "string" && typeof p?.at === "number",
          )
          .map((p) => ({
            id: p.id,
            at: p.at,
            ...(typeof p.name === "string" && p.name && { name: p.name }),
            ...(typeof p.platform === "string" &&
              p.platform && { platform: p.platform }),
          }))
      : [];
  } catch {
    return [];
  }
}

function save(list: RecentPeer[]): RecentPeer[] {
  const trimmed = list.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // storage unavailable: keep the list for this page only
  }
  return trimmed;
}

/** Moves the peer to the front. A no-op when the user turned remembering off. */
export function rememberPeer(
  list: RecentPeer[],
  id: string,
  platform?: string,
): RecentPeer[] {
  if (!loadRemember()) return list;
  const old = list.find((p) => p.id === id);
  const peer: RecentPeer = { id, at: Date.now() };
  if (old?.name) peer.name = old.name;
  const plat = platform || old?.platform;
  if (plat) peer.platform = plat;
  return save([peer, ...list.filter((p) => p.id !== id)]);
}

/** An empty name removes it. */
export function renamePeer(
  list: RecentPeer[],
  id: string,
  name: string,
): RecentPeer[] {
  const n = name.trim();
  return save(
    list.map((p) => {
      if (p.id !== id) return p;
      const { name: _, ...rest } = p;
      return n ? { ...rest, name: n } : rest;
    }),
  );
}

export function forgetPeer(list: RecentPeer[], id: string): RecentPeer[] {
  dropPeerSettings([id]);
  return save(list.filter((p) => p.id !== id));
}

export function forgetAll(list: RecentPeer[]): RecentPeer[] {
  dropPeerSettings(list.map((p) => p.id));
  return save([]);
}
