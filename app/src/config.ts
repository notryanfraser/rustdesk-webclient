// Server settings, provided at runtime by /config.js (written by the container at start-up from
// RUSTDESK_ID_SERVER / RUSTDESK_KEY, or by `npm run dev`), so one build serves any deployment.
export interface AppConfig {
  /** ID server as configured for RustDesk clients, e.g. "rustdesk-id.example.com:441". */
  idServer: string;
  /** hbbs public key (id_ed25519.pub), base64. */
  key: string;
  /**
   * Use wss:// for hbbs/hbbr. Default: the page's own scheme (an https page must use wss).
   * Set true when the page is plain http but the servers are behind TLS (e.g. a local test page).
   */
  wss: boolean;
}

declare global {
  interface Window {
    RUSTDESK_WEB_CONFIG?: Partial<AppConfig>;
  }
}

/** The configuration, or a list of what is missing. */
export function loadConfig(): AppConfig | { missing: string[] } {
  const c = window.RUSTDESK_WEB_CONFIG ?? {};
  const missing = [];
  if (!c.idServer) missing.push("RUSTDESK_ID_SERVER");
  if (!c.key) missing.push("RUSTDESK_KEY");
  if (missing.length) return { missing };
  return {
    idServer: c.idServer!,
    key: c.key!,
    wss: c.wss ?? location.protocol === "https:",
  };
}
