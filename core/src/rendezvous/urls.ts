// Port arithmetic for the browser-facing WebSocket endpoints of hbbs / hbbr.
//
// Ported from rustdesk 1.2.5 flutter/web/js/src/connection.ts `getrUriFromRs`
// (AGPL-3.0), with the sloth-os scheme patch (ws:// vs wss:// from the page).

import { ConfigError } from "../errors.js";

const DEFAULT_PORT = 21116; // hbbs native port; the reference derives the rest from it
const ID_OFFSET = 2; // 21116 + 2 = 21118, hbbs WebSocket
const RELAY_BARE_OFFSET = 3; // 21116 + 3 = 21119, hbbr WebSocket
const RELAY_PORT_OFFSET = 2; // advertised hbbr 21117 -> 21119

function scheme(pageIsHttps: boolean): string {
  return pageIsHttps ? "wss://" : "ws://";
}

function build(
  value: string,
  pageIsHttps: boolean,
  portOffset: number,
  bareOffset: number,
  what: string,
): string {
  const v = value.trim();
  if (v === "")
    throw new ConfigError(
      "BAD_SERVER_ADDRESS",
      `${what}: empty server address`,
    );
  if (v.includes("://") || v.includes("/")) {
    throw new ConfigError(
      "BAD_SERVER_ADDRESS",

      `${what}: expected "host" or "host:port", not a URL (${JSON.stringify(v)})`,
    );
  }
  const parts = v.split(":");
  if (parts.length > 2) {
    // The reference splits on ":" and cannot represent IPv6 literals.
    throw new ConfigError(
      "BAD_SERVER_ADDRESS",
      `${what}: IPv6 literals are not supported (${v})`,
    );
  }
  const host = parts[0] ?? "";
  if (host === "")
    throw new ConfigError(
      "BAD_SERVER_ADDRESS",
      `${what}: missing host in ${JSON.stringify(v)}`,
    );
  let port: number;
  if (parts.length === 2) {
    const p = parts[1] ?? "";
    if (!/^\d+$/.test(p))
      throw new ConfigError(
        "BAD_SERVER_ADDRESS",
        `${what}: bad port in ${JSON.stringify(v)}`,
      );
    port = Number(p) + portOffset;
  } else {
    port = DEFAULT_PORT + bareOffset;
  }
  if (port > 65535)
    throw new ConfigError(
      "BAD_SERVER_ADDRESS",
      `${what}: port ${port} out of range`,
    );
  return `${scheme(pageIsHttps)}${host}:${port}`;
}

/**
 * WebSocket URL of hbbs for a configured ID server.
 * `host:port` -> port + 2; bare `host` -> 21118. No path, no query.
 */
export function idServerUrl(configured: string, pageIsHttps: boolean): string {
  return build(configured, pageIsHttps, ID_OFFSET, ID_OFFSET, "id server");
}

/**
 * WebSocket URL of hbbr for the `relay_server` string in a RelayResponse.
 * `host:port` -> port + 2 (21117 -> 21119); bare `host` -> 21119.
 */
export function relayUrl(relayServer: string, pageIsHttps: boolean): string {
  return build(
    relayServer,
    pageIsHttps,
    RELAY_PORT_OFFSET,
    RELAY_BARE_OFFSET,
    "relay server",
  );
}

/**
 * Fallback used by the reference when RelayResponse.relay_server is empty
 * (`getDefaultUri(true)`): the ID server host with offset 3 (`host:port` ->
 * port + 3; bare host -> 21119).
 */
export function defaultRelayUrl(
  configuredIdServer: string,
  pageIsHttps: boolean,
): string {
  return build(
    configuredIdServer,
    pageIsHttps,
    RELAY_BARE_OFFSET,
    RELAY_BARE_OFFSET,
    "id server",
  );
}
