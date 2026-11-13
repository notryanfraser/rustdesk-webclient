# rustdesk-web

A web client for your self-hosted [RustDesk](https://rustdesk.com) server. Open a page and
control any of your RustDesk machines from a browser, with nothing to install.

> rustdesk-web is an independent project. It works with RustDesk but is not made or
> endorsed by the RustDesk team. It speaks RustDesk's protocol to the open-source
> `rustdesk-server` (hbbs/hbbr).

**What works**

- Screen (H.264 and H.265 where the browser decodes them and the remote has a hardware
  encoder, otherwise VP9 or VP8, through the browser's WebCodecs, hardware-decoded where the
  browser offers it), with quality, frame rate and
  scaling settings, and every monitor of the remote at once
- Keyboard (by position or by character), mouse, touch with an on-screen key bar, and
  Ctrl+Alt+Del
- Audio from the remote
- Clipboard text, both ways
- File transfer, both ways, including folders and large files
- Chat with the person at the remote
- Session recording to a WebM file
- Installs as an app (PWA) on desktop and mobile

**Browsers:** current Chrome, Edge, Firefox and Safari, on desktop, iOS and Android.

**Limitations**

- Every browser session goes through your relay (hbbr): browsers cannot do RustDesk's direct
  UDP connection.
- Audio only flows from the remote to you; there is no microphone.
- The page has no login of its own: each remote still needs its password (or the person
  there to accept). See [Securing it](#securing-it).

## How it fits together

Browsers can't open raw TCP connections, so the web client talks to hbbs and hbbr over
WebSocket, which both already serve: hbbs on port **21118**, hbbr on **21119**. Browsers
insist on TLS (`wss://`) for a page served over https, so a reverse proxy in front adds it:

```
                          ┌──────────── reverse proxy (TLS) ────────────┐
browser ── https://rustdesk.example.com        ──►  rustdesk-web:8080     (the page)
        ── wss://rustdesk.example.com:21118    ──►  hbbs:21118            (ID server)
        ── wss://rustdesk.example.com:21119    ──►  hbbr:21119            (relay)

native RustDesk clients ── rustdesk.example.com:21115-21117 ──► hbbs / hbbr (unchanged)
```

The client works out those addresses itself, the same way RustDesk's own web client does:

- **ID server:** from the address you configure. `host` gives `host:21118`; `host:port` gives
  `host:port+2`.
- **Relay:** from the relay address hbbs hands out (its `-r` setting) on port 21119.
- **Paths:** none; the WebSocket requests go to `/`.

So one hostname with a certificate, and three TLS ports on your proxy, is all it needs.

## Set it up

You need:

- Docker with Compose.
- A hostname for your RustDesk server, e.g. `rustdesk.example.com`, that resolves to the
  machine running Docker. Inside your network, it must resolve there too: use local DNS, or a
  router that supports hairpin NAT.
- A reverse proxy that can get a certificate for that name.

**1. Get the files and set the hostname**

```sh
git clone https://github.com/notryanfraser/rustdesk-webclient.git && cd rustdesk-webclient
cp .env.example .env        # then set RUSTDESK_HOST
```

**2. Start the RustDesk server and copy its key**

```sh
docker compose up -d hbbs hbbr
cat data/id_ed25519.pub     # paste this into .env as RUSTDESK_KEY
```

**3. Start the web client**

```sh
docker compose up -d
```

**4. Put your reverse proxy in front.** Follow the guide for yours:

| Proxy | Guide |
|---|---|
| Caddy | [docs/proxy/caddy.md](docs/proxy/caddy.md) |
| Traefik | [docs/proxy/traefik.md](docs/proxy/traefik.md) |
| nginx, or SWAG | [docs/proxy/nginx.md](docs/proxy/nginx.md) |
| Nginx Proxy Manager | [docs/proxy/nginx-proxy-manager.md](docs/proxy/nginx-proxy-manager.md) |

**5. Open the ports.** If you use it from outside your network, forward TCP 443, 21118 and
21119 to the proxy, plus RustDesk's usual 21115-21117 (TCP) and 21116 (UDP) to hbbs/hbbr.

**6. Connect.** Open `https://rustdesk.example.com`, enter a remote's ID and password, and
press Connect. The remotes must use the same server: set their ID server to
`rustdesk.example.com` and their Key to the contents of `id_ed25519.pub`.

### Already running a RustDesk server?

Keep it, and just add the `rustdesk-web` service (copy it from [docker-compose.yml](docker-compose.yml))
with `RUSTDESK_ID_SERVER` set to the address your clients use.

- **Ports:** your proxy must be able to listen on 21118 and 21119 for that hostname.
  - If hbbs/hbbr publish 21118/21119 on the same machine (for example with
    `network_mode: host`, as in RustDesk's own compose file), stop publishing those two
    ports.
  - Then give the proxy access over a Docker network, as this repo's compose file does.
- **Relay address:** check hbbs's relay setting (`-r`). It must be a hostname your proxy has a
  certificate for, without a port or with `:21117`.

### Configuration

The `rustdesk-web` container reads two variables:

| Variable | Required | Value |
|---|---|---|
| `RUSTDESK_ID_SERVER` | yes | The ID server as native clients write it: `host` or `host:port` |
| `RUSTDESK_KEY` | yes | Contents of hbbs's `id_ed25519.pub` |

Other details:

- **Port:** the container serves the app on port 8080, at `/rustdesk/` (`/` redirects there).
- **Health check:** `GET /healthz` returns `ok`.
- **Bad configuration:** the container refuses to start on bad values, and its log says why.

**Only port 443 available?** Set `RUSTDESK_ID_SERVER=rustdesk-id.example.com:441`. The
client adds 2, giving `wss://rustdesk-id.example.com:443`, and you give hbbs's WebSocket its
own hostname on 443. The relay can't move this way: hbbs's relay address is shared with native
clients, so browsers always use 21119 for it.

## Securing it

- **What the page is:** static files plus the server address and its public key. That's the
  same information every native client is given.
- **What protects a session:** the remote's password, sent only as a salted challenge hash.
  The session is encrypted end to end with the remote, after the client checks the remote's
  identity against your server's key, so the proxy and relay only see ciphertext.
- **What a login adds:** the page lets anyone who can load it try passwords against your
  remotes. To narrow that, restrict the page by network (LAN or VPN only) in your proxy, or
  put a forward-auth login (Authelia, Authentik, …) in front of it.
- **Applying a login:** protect 443, 21118 and 21119 together (browsers send the login cookie
  on the WebSockets too), and never hbbs/hbbr's native ports.

[SECURITY.md](SECURITY.md) has the details: the CSP, what the client stores, and how to
report a vulnerability.

## Troubleshooting

| The app says | Check |
|---|---|
| "Couldn't reach the server" or "Timed out connecting to the server" | `wss://rustdesk.example.com:21118` must reach hbbs through your proxy (test below). |
| "Server key mismatch" | `RUSTDESK_KEY` must be the contents of the `id_ed25519.pub` that hbbs is using. |
| "That ID isn't registered with your server" | The remote isn't registered with this server: check its ID server and Key settings. |
| It finds the remote, then can't connect | `wss://<hbbs's relay host>:21119` must reach hbbr (test below); check hbbs's `-r`. |
| hbbs's log says `relay-servers=[]` | hbbs drops a `-r` name it can't resolve when it starts: check DNS from the hbbs container, then restart hbbs. |
| Connected, but the screen stays black | The browser can't decode the remote's codec (H.264, H.265, VP9 or VP8). Update the browser, or try another. |

**Test a WebSocket through the proxy.** Expect `HTTP/1.1 101 Switching Protocols`; curl then
waits, so stop it with Ctrl+C:

```sh
curl -i --http1.1 https://rustdesk.example.com:21118/ \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
```

Repeat with port 21119 for the relay. A `502` means the proxy can't reach hbbs/hbbr; any other
status means the proxy isn't passing the WebSocket upgrade on.

## Build from source

```sh
docker build -f docker/Dockerfile -t rustdesk-web .
```

Then use `image: rustdesk-web` in the compose file. Development needs Node 22:

```sh
cd core && npm ci && npm test        # protocol core: TypeScript, tests with vitest
cd ../app && npm ci && npm run dev   # the Preact UI, served locally
```

The code has two parts:

- **`core/`:** the protocol, which has no UI and no framework. It handles rendezvous, the
  secure handshake, the session, video, audio, input, clipboard, files, chat and recording.
- **`app/`:** the browser UI.

The protobuf schemas in `core/protos` come from RustDesk 1.5.3.

## License

[AGPL-3.0](LICENSE), like RustDesk itself. Parts are ported from RustDesk's own code
([rustdesk/rustdesk](https://github.com/rustdesk/rustdesk)), mainly its 1.2.5 web client and
the 1.5.3 protocol definitions. Those files say so in their headers. The keyboard code tables
come from [rdev](https://github.com/Narsil/rdev) (MIT, `core/vendor/rdev/LICENSE`). If you run
a modified version for others, the AGPL requires you to offer them its source.

"RustDesk" is the name of the RustDesk project and is used here only to say what this client
works with.
