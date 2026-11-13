# Test fixtures

Captured from real traffic on 2026-11-12: the web client (and RustDesk's 1.2.5 web client, for
comparison) against OSS hbbs/hbbr 1.1.16 and a RustDesk 1.5.3 peer on Linux/X11.

| File | Contents |
|---|---|
| `decoded/2026-11-12-browser-to-peer.json` | RustDesk 1.2.5's web client: rendezvous, relay and the start of the secure handshake |
| `decoded/2026-11-12-core-client-login-session.json` | This client: the same handshake, then an encrypted login session |
| `decoded/2026-11-12-video-frames.json` | Plaintext `Message`s from the peer: codec negotiation, then VP9, VP8 and AV1 frames |
| `decoded/2026-11-12-audio-frames.json` | Plaintext audio messages from the peer (a 440 Hz tone, Opus) |
| `crypto-vectors.json` | Key exchange and secretbox vectors (`tools/vectors/gen_vectors.py`, libsodium) |
| `zstd-vectors.json` | zstd frames made like the peer's (`tools/vectors/gen_zstd.py`, libzstd) |

Changed before publishing, so the captures do not identify the server they came from:

- The server's domain is replaced by `example.net`, the same length, so the protobuf framing is unchanged.
- hbbs's key is replaced by a fixed test key. hbbs's signature over the peer's `IdPk` (`RelayResponse.pk`) was re-made with it, so the tests verify signatures exactly as against a real server. The test key's seed is `sha256("rustdesk-web test fixture hbbs key")`.

Everything else (the peer's own signature, the key exchange, the ciphertext) is as captured.
