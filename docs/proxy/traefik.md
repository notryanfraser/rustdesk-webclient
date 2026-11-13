# Traefik

Traefik (v3) needs two extra entrypoints, one for each WebSocket port, and labels on the three
services.

## 1. Traefik's static configuration

Add the two entrypoints. In Traefik's compose file:

```yaml
services:
  traefik:
    image: traefik:v3
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=rustdesk
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --entrypoints.rustdesk-id.address=:21118
      - --entrypoints.rustdesk-relay.address=:21119
      - --certificatesresolvers.le.acme.tlschallenge=true
      - --certificatesresolvers.le.acme.email=you@example.com
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
    ports:
      - "80:80"
      - "443:443"
      - "21118:21118"
      - "21119:21119"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    networks:
      - rustdesk

networks:
  rustdesk:
    external: true
```

Already run Traefik? Add the two `rustdesk-*` entrypoint lines, the two ports and the
`rustdesk` network to it. Your existing certificate resolver works; use its name below
instead of `le`.

## 2. Labels on the RustDesk services

Save this as `docker-compose.override.yml` next to this repo's `docker-compose.yml`. Compose
merges it automatically, and `${RUSTDESK_HOST}` comes from `.env`:

```yaml
services:
  rustdesk-web:
    labels:
      - traefik.enable=true
      - traefik.http.routers.rustdesk-web.rule=Host(`${RUSTDESK_HOST}`)
      - traefik.http.routers.rustdesk-web.entrypoints=websecure
      - traefik.http.routers.rustdesk-web.tls.certresolver=le
      - traefik.http.services.rustdesk-web.loadbalancer.server.port=8080

  hbbs:
    labels:
      - traefik.enable=true
      - traefik.http.routers.rustdesk-id.rule=Host(`${RUSTDESK_HOST}`)
      - traefik.http.routers.rustdesk-id.entrypoints=rustdesk-id
      - traefik.http.routers.rustdesk-id.tls.certresolver=le
      - traefik.http.services.rustdesk-id.loadbalancer.server.port=21118

  hbbr:
    labels:
      - traefik.enable=true
      - traefik.http.routers.rustdesk-relay.rule=Host(`${RUSTDESK_HOST}`)
      - traefik.http.routers.rustdesk-relay.entrypoints=rustdesk-relay
      - traefik.http.routers.rustdesk-relay.tls.certresolver=le
      - traefik.http.services.rustdesk-relay.loadbalancer.server.port=21119
```

Then `docker compose up -d` again.

The `loadbalancer.server.port` lines are required: hbbs and hbbr listen on several ports, and
Traefik must be told which one speaks WebSocket. WebSockets need no other settings: Traefik
passes them through and doesn't time out idle ones.

Next: back to [the README, step 5](../../README.md#set-it-up).
