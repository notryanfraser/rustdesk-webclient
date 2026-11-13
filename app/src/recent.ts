// Recently used peer IDs, newest first, in localStorage. Only IDs: passwords are never stored.
// Storage can be unavailable (private windows, blocked site data); the app then works without it.
export interface RecentPeer {
  id: string;
  /** Last successful connection, ms since epoch. */
  at: number;
}

const KEY = "rustdesk-web.recent-peers";
const MAX = 8;

export function loadRecent(): RecentPeer[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v)
      ? v.filter(
          (p): p is RecentPeer =>
            typeof p?.id === "string" && typeof p?.at === "number",
        )
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

export function rememberPeer(list: RecentPeer[], id: string): RecentPeer[] {
  return save([{ id, at: Date.now() }, ...list.filter((p) => p.id !== id)]);
}

export function forgetPeer(list: RecentPeer[], id: string): RecentPeer[] {
  return save(list.filter((p) => p.id !== id));
}
