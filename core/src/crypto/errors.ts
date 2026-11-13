import { RustDeskError } from "../errors.js";

export type SecureErrorCode =
  /** No hbbs key configured (upstream silently substitutes the public RustDesk key; we refuse). */
  | "NO_SERVER_KEY"
  /** The configured key is not base64 of 32 bytes. */
  | "BAD_SERVER_KEY"
  /** hbbs sent no signed IdPk (RelayResponse.pk empty): there is nothing to authenticate the peer with. */
  | "NO_SERVER_PK"
  /** An ed25519 signature did not verify (wrong key, tampered, truncated). */
  | "BAD_SIGNATURE"
  /** The signed IdPk names a different peer ID than the one we asked for. */
  | "ID_MISMATCH"
  /** A public key inside a signed IdPk is not 32 bytes (or is a low-order point). */
  | "BAD_KEY"
  /** Undecodable protobuf, or the peer sent something other than SignedId. */
  | "PROTOCOL"
  /** The relay closed / timed out before the handshake finished. */
  | "CLOSED"
  | "TIMEOUT"
  /** A frame failed secretbox authentication (tampered, replayed, reordered, wrong key). */
  | "DECRYPT_FAILED"
  /** A frame is too short to contain a secretbox MAC. */
  | "BAD_FRAME"
  /** The send or receive counter would exceed 2^53 - 1. */
  | "COUNTER_EXHAUSTED"
  /** The transport already failed with a SecureError; no further traffic is allowed. */
  | "FAILED";

/**
 * Every handshake or channel failure. There is deliberately no code for "fall back to
 * unencrypted": upstream clients do that on several of these conditions
 * (connection.ts:177-221, client.rs:1686-1700, 1750-1776); this library never does.
 */
export class SecureError extends RustDeskError<"secure", SecureErrorCode> {
  constructor(
    code: SecureErrorCode,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super("secure", code, message ?? code, options);
    this.name = "SecureError";
  }
}
