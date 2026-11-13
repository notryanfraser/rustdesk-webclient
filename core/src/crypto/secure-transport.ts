// Encrypted FrameTransport. Ported from
// rustdesk 1.2.5 flutter/web/js/src/websock.ts sendMessage 42-52, _recv_message 167-183
// rustdesk 1.2.5 flutter/web/js/src/globals.js makeOnce 167-177, encrypt/decrypt 179-185
// hbb_common fae47e0 src/tcp.rs Encrypt::enc/dec 382-402, FramedStream::get_nonce 248-252
//
// Frame layout: crypto_secretbox_easy output = 16-byte Poly1305 MAC || ciphertext, one frame
// per WebSocket binary message, no length prefix, no counter on the wire.
// Nonce (24 bytes): the per-direction message counter as a little-endian u64 in bytes 0..7,
// bytes 8..23 zero. Each direction has its own counter, both start at 0 and are incremented
// BEFORE use, so the first frame in each direction uses counter 1 (websock.ts:48,172;
// tcp.rs:386,399). Same key in both directions (original scheme, kx_version 0).

import nacl from "tweetnacl";
import type { CloseInfo, FrameTransport } from "../transport/types.js";
import { SecureError } from "./errors.js";

const MAC_BYTES = nacl.secretbox.overheadLength; // 16
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

/** 24-byte nonce for message number `counter` (little-endian u64 in the first 8 bytes). */
export function counterNonce(counter: number): Uint8Array {
  const nonce = new Uint8Array(nacl.secretbox.nonceLength);
  const dv = new DataView(nonce.buffer);
  dv.setUint32(0, counter % 0x1_0000_0000, true);
  dv.setUint32(4, Math.floor(counter / 0x1_0000_0000), true);
  return nonce;
}

export class SecureTransport implements FrameTransport {
  private sendCounter = 0;
  private recvCounter = 0;
  private failure: SecureError | undefined;

  constructor(
    private readonly inner: FrameTransport,
    private readonly key: Uint8Array,
  ) {
    if (key.length !== nacl.secretbox.keyLength)
      throw new SecureError("BAD_KEY", "session key must be 32 bytes");
  }

  get closed(): Promise<CloseInfo> {
    return this.inner.closed;
  }

  /** Number of frames sent / received so far (the next frame uses counter + 1). */
  get counters(): { send: number; recv: number } {
    return { send: this.sendCounter, recv: this.recvCounter };
  }

  send(frame: Uint8Array): void {
    if (this.failure) throw this.failure;
    if (this.sendCounter >= MAX_COUNTER)
      throw this.fail(new SecureError("COUNTER_EXHAUSTED"));
    const sealed = nacl.secretbox(
      frame,
      counterNonce(this.sendCounter + 1),
      this.key,
    );
    this.sendCounter += 1;
    this.inner.send(sealed);
  }

  /** Backpressure of the socket underneath (sealed frames are what it buffers). */
  drained(): Promise<void> {
    return this.inner.drained?.() ?? Promise.resolve();
  }

  async recv(timeoutMs?: number): Promise<Uint8Array> {
    if (this.failure) throw this.failure;
    // Timeout / closed errors from the inner transport pass through unchanged.
    const frame = await this.inner.recv(timeoutMs);
    if (this.failure) throw this.failure;
    // Native dec() lets frames of <= 1 byte through unencrypted (tcp.rs:383-385); we do not:
    // anything that cannot hold a MAC is an error.
    if (frame.length < MAC_BYTES)
      throw this.fail(
        new SecureError("BAD_FRAME", `frame of ${frame.length} bytes`),
      );
    if (this.recvCounter >= MAX_COUNTER)
      throw this.fail(new SecureError("COUNTER_EXHAUSTED"));
    const plain = nacl.secretbox.open(
      frame,
      counterNonce(this.recvCounter + 1),
      this.key,
    );
    if (plain === null)
      throw this.fail(
        new SecureError(
          "DECRYPT_FAILED",
          `frame ${this.recvCounter + 1} failed authentication`,
        ),
      );
    this.recvCounter += 1;
    return plain;
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }

  /** Records the failure, closes the socket, returns the error to throw. Never leaks plaintext. */
  private fail(err: SecureError): SecureError {
    this.failure ??= err;
    this.inner.close(1008, err.code);
    return this.failure;
  }
}
