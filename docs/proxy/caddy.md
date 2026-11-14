# Caddy

Caddy gets the certificate for you and passes WebSockets through without extra settings.

## 1. Caddyfile

Replace `rustdesk.example.com` with your `RUSTDESK_HOST`:

```caddyfile
# The web client
rustdesk.example.com {
	reverse_proxy ferry:8080
}

# hbbs WebSocket (ID server)
rustdesk.example.com:21118 {
	reverse_proxy hbbs:21118
}

# hbbr WebSocket (relay)
rustdesk.example.com:21119 {
	reverse_proxy hbbr:21119
}
```

Caddy gets one certificate for the name and uses it on all three ports.

## 2. Caddy's container

Caddy must publish the two extra ports and join the `rustdesk` network, which this repo's
`docker-compose.yml` creates:

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"        # certificate challenges and the https redirect
      - "443:443"
      - "21118:21118"
      - "21119:21119"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    networks:
      - rustdesk

volumes:
  caddy_data:

networks:
  rustdesk:
    external: true
```

Already have a Caddy container? Add the two ports and the network to it.

## Caddy not in Docker?

Publish the ports in this repo's `docker-compose.yml` instead, bound to localhost:

- `"127.0.0.1:8080:8080"` on `ferry`
- `"127.0.0.1:21118:21118"` on `hbbs`
- `"127.0.0.1:21119:21119"` on `hbbr`

Then point the Caddyfile at `localhost:8080`, `localhost:21118` and `localhost:21119`.

Next: back to [the README, step 5](../../README.md#set-it-up).
