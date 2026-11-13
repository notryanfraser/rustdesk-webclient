# nginx and SWAG

Three `server` blocks for one hostname: the web client on 443, and hbbs and hbbr's WebSockets
on 21118 and 21119. For SWAG, skip to [SWAG](#swag).

## Plain nginx

This assumes nginx runs in Docker on the `rustdesk` network (this repo's `docker-compose.yml`
creates it), publishes ports 443, 21118 and 21119, and already has a certificate for your
hostname.

```nginx
# /etc/nginx/conf.d/rustdesk.conf  (http context)
# Replace rustdesk.example.com and the certificate paths with yours.

map $http_upgrade $rustdesk_connection {
    default upgrade;
    ""      close;
}

# The web client
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name rustdesk.example.com;
    ssl_certificate     /etc/letsencrypt/live/rustdesk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rustdesk.example.com/privkey.pem;

    location / {
        proxy_pass http://rustdesk-web:8080;
        proxy_set_header Host $host;
    }
}

# hbbs WebSocket (ID server)
server {
    listen 21118 ssl;
    listen [::]:21118 ssl;
    server_name rustdesk.example.com;
    ssl_certificate     /etc/letsencrypt/live/rustdesk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rustdesk.example.com/privkey.pem;

    location / {
        proxy_pass http://hbbs:21118;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $rustdesk_connection;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}

# hbbr WebSocket (relay)
server {
    listen 21119 ssl;
    listen [::]:21119 ssl;
    server_name rustdesk.example.com;
    ssl_certificate     /etc/letsencrypt/live/rustdesk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rustdesk.example.com/privkey.pem;

    location / {
        proxy_pass http://hbbr:21119;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $rustdesk_connection;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}
```

What the WebSocket blocks need, and why:

- **HTTP/1.1 and the `Upgrade`/`Connection` headers:** without them nginx doesn't pass the
  WebSocket on.
- **Long timeouts:** nginx's default of 60 s would cut idle sessions.
- **No buffering:** so the stream flows through as it arrives.
- **`X-Real-IP`:** hbbs and hbbr read the client's address from it.

Then `nginx -t` and reload. nginx looks up `rustdesk-web`, `hbbs` and `hbbr` when it starts, so
start this repo's stack first.

**nginx not in Docker?** Publish the three ports in `docker-compose.yml`, bound to localhost:

- `"127.0.0.1:8080:8080"` on `rustdesk-web`
- `"127.0.0.1:21118:21118"` on `hbbs`
- `"127.0.0.1:21119:21119"` on `hbbr`

Then use `127.0.0.1:<port>` in the `proxy_pass` lines.

## SWAG

[SWAG](https://docs.linuxserver.io/general/swag/) is nginx with certificates managed for you.

1. **Certificate:** if your hostname is a subdomain of SWAG's `URL`, add it to `SUBDOMAINS`
   (e.g. `SUBDOMAINS=rustdesk`). A wildcard certificate already covers it.
2. **Ports and network:** SWAG must publish `21118` and `21119` and join the `rustdesk`
   network:

   ```yaml
   services:
     swag:
       ports:
         - "443:443"
         - "80:80"
         - "21118:21118"
         - "21119:21119"
       networks:
         - rustdesk
   networks:
     rustdesk:
       external: true
   ```

3. **Proxy conf:** save this as `/config/nginx/proxy-confs/rustdesk.subdomain.conf`, then
   restart SWAG:

```nginx
# rustdesk-web, hbbs and hbbr behind SWAG. Assumes the hostname rustdesk.<your domain>;
# change server_name if yours differs.

# The web client
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name rustdesk.*;
    include /config/nginx/ssl.conf;

    location / {
        include /config/nginx/proxy.conf;
        include /config/nginx/resolver.conf;
        set $upstream_app rustdesk-web;
        set $upstream_port 8080;
        set $upstream_proto http;
        proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    }
}

# hbbs WebSocket (ID server)
server {
    listen 21118 ssl;
    listen [::]:21118 ssl;
    server_name rustdesk.*;
    include /config/nginx/ssl.conf;

    location / {
        # proxy.conf is not included here: its timeouts would clash with the ones below.
        include /config/nginx/resolver.conf;
        set $upstream_app hbbs;
        set $upstream_port 21118;
        proxy_pass http://$upstream_app:$upstream_port;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}

# hbbr WebSocket (relay)
server {
    listen 21119 ssl;
    listen [::]:21119 ssl;
    server_name rustdesk.*;
    include /config/nginx/ssl.conf;

    location / {
        include /config/nginx/resolver.conf;
        set $upstream_app hbbr;
        set $upstream_port 21119;
        proxy_pass http://$upstream_app:$upstream_port;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}
```

`$connection_upgrade` comes from SWAG's own `nginx.conf`. The `set $upstream_app` lines make
SWAG look the containers up per request, so it starts even while they are down.

Next: back to [the README, step 5](../../README.md#set-it-up).
