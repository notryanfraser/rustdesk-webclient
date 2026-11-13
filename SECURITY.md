# Security

## Reporting a vulnerability

Please report vulnerabilities privately, through this repository's **Security** tab, using
**Report a vulnerability**. Don't open a public issue. Vulnerabilities in RustDesk itself
(hbbs, hbbr, the RustDesk app) belong with [the RustDesk project](https://github.com/rustdesk/rustdesk/security).

## How the client is built to be safe

The web client controls machines: their keyboard, mouse, screen, audio, clipboard and files.
Anyone who can use it with a remote's password has that machine. This section covers what
protects a session, what a hostile remote or network can do to the browser, and what the
client leaves behind.

### Who can reach it

Each session needs the remote's password, or the person at the remote to accept. Remotes lock
out repeated wrong passwords. The page itself has no login, so anyone who can load it can try
passwords against your remotes. You can narrow that at your reverse proxy:

- **By network:** allow only your LAN or VPN addresses.
- **With a login:** put forward-auth (Authelia, Authentik, …) in front of ports 443, 21118
  and 21119. Browsers send the login cookie on the WebSockets too, so the cookie's domain must
  cover the hostname. Leave hbbs/hbbr's native ports (21115-21117) alone: native clients can't
  do a web login.

### What protects a session

- **TLS to your proxy.** The client only uses `wss://` from an https page. The page's CSP allows
  `wss:` and never `ws:`, so it can't fall back to an unencrypted WebSocket.
- **Encryption with the remote.** The relay only ever carries ciphertext. Before sending
  anything secret, the client checks the remote's identity:
  1. hbbs's signature on the remote's key is checked against your server's key from `RUSTDESK_KEY`.
  2. The remote's own signature is checked against that key.
  3. Only then does the client send its key exchange.

  After that, every message is a NaCl secretbox. A relay or network attacker without hbbs's
  signing key can't impersonate a remote. The client refuses to connect if verification
  fails; it never falls back to an unencrypted session.
- **The password never goes on the wire.** It goes into RustDesk's challenge hash,
  `sha256(sha256(password + salt) + challenge)`.

### What the page can run

The image's nginx sends this Content-Security-Policy on every response:

```
default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' wss:; img-src 'self';
style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none';
manifest-src 'self'
```

- **Scripts:** no inline script, no `eval`, no `blob:` or `data:` sources.
- **Framing:** none (`frame-ancestors 'none'`), so the page can't be clickjacked into sending input.
- **Other headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a
  `Permissions-Policy` denying camera, microphone and geolocation.
- **Known quirk:** WebKit (Safari) reports `style-src-attr` violations from its own built-in
  `<select>` rendering. They come from the engine, not the app; the selects work.

The CSP leaves out HSTS: set it at your reverse proxy if you want it.

### What a hostile remote (or relay) could send

Every string a remote supplies is rendered as text, never as HTML: file names, clipboard text,
display names and error reasons. Nothing in the client uses `innerHTML`, `document.write`,
`eval` or `new Function`.

| Input | Limit |
|---|---|
| Messages | Decoded by protobuf-es (no `eval`); unknown fields ignored |
| Video, audio | Decoded by the browser's sandboxed WebCodecs decoders |
| Clipboard text | 32 MiB, compressed or not; zstd output is bounded |
| File blocks | Decompressed with a bounded output size |
| File names in folder downloads | Must be plain names: a `.` or `..` part fails the download |
| Download size | Checked against browser storage first; the in-memory fallback stops at 512 MiB |

### What the client leaves behind

- **localStorage:**
  - recent remote IDs;
  - per-remote view settings: quality, frame rate, scaling and keyboard mode;
  - the theme.
- **Service worker cache:** the app's files and `config.js`, which holds the server address
  and its public key.
- **Browser storage (OPFS):** temporary download files, deleted when the download finishes or
  is cancelled, and at the next start.
- **Passwords:** the app never stores them. A password stays in memory while its session is
  open, so the Files panel can open its own connection, and is dropped when the session ends.
  Your browser's password manager may offer to save it; that's your choice.

### The container

The container serves static files only:

- **Filesystem:** a read-only root filesystem, as in the provided `docker-compose.yml`.
- **Privileges:** all capabilities dropped, and `no-new-privileges`.
- **User:** nginx runs as a non-root user.
- **Startup:** it refuses to start without a valid server address and key.

### Dependencies

There are four runtime dependencies, all bundled into the image; nothing loads from a CDN:

- `@bufbuild/protobuf`
- `tweetnacl`
- `fzstd`
- `preact`

Lockfiles are committed, the image build installs with `npm ci --ignore-scripts`, and the base
images are pinned.

### Known limits

1. **Anyone who can load the page can try passwords.** Restrict it by network or login, as
   above.
2. **A password stays in memory for the length of its session.**
3. **The page is only as trustworthy as whoever serves it.** A compromised proxy or image could
   serve a different key or app. That is inherent to any web client.
