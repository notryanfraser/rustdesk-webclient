// Password proof for the peer's `Hash` challenge.
//
// Reference (the scheme the peer verifies):
// rustdesk 1.2.5 flutter/web/js/src/connection.ts `login()` 437-452:
// p = hash([password, salt]); p = hash([p, challenge]); // hash() = SHA-256 over the
// concatenation, strings UTF-8 encoded (connection.ts:1042-1051)
// rustdesk 1.5.3 src/client.rs handle_hash 4701-4707 (h1 = SHA256(password || salt)),
// peer side src/server/connection.rs verify_h1 2521-2530 (SHA256(h1 || challenge) compared in
// constant time with LoginRequest.password) and validate_password_plain 2532-2542
// (h1 = SHA256(password || salt)).
//
// salt and challenge are the string fields of `Hash`; both sides hash their UTF-8 bytes
// (connection.ts TextEncoder; connection.rs `.as_bytes()`).

import { sha256 } from "./sha256.js";

const utf8 = new TextEncoder();

function bytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? utf8.encode(v) : v;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** h1 = SHA-256(password || salt): what the peer stores / what 1.5.3 clients cache. */
export function hashPasswordSalted(
  password: string | Uint8Array,
  salt: string | Uint8Array,
): Uint8Array {
  return sha256(concat(bytes(password), bytes(salt)));
}

/** LoginRequest.password = SHA-256(SHA-256(password || salt) || challenge), 32 bytes. */
export function hashPassword(
  password: string | Uint8Array,
  salt: string | Uint8Array,
  challenge: string | Uint8Array,
): Uint8Array {
  return sha256(concat(hashPasswordSalted(password, salt), bytes(challenge)));
}
