# Nginx Proxy Manager

The web client is an ordinary proxy host. NPM's interface can't add TLS listeners on other
ports, though, so the two WebSocket ports go in NPM's custom config file. That is one small
file, and NPM keeps it across updates.

## 1. NPM's container

NPM must publish `21118` and `21119` and join the `rustdesk` network, which this repo's
`docker-compose.yml` creates:

```yaml
services:
  npm:
    image: jc21/nginx-proxy-manager:2
    ports:
      - "80:80"
      - "81:81"
      - "443:443"
      - "21118:21118"
      - "21119:21119"
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
    networks:
      - rustdesk

networks:
  rustdesk:
    external: true
```

## 2. A proxy host for the web client

**Hosts → Proxy Hosts → Add Proxy Host**:

| Tab | Field | Value |
|---|---|---|
| Details | Domain Names | `rustdesk.example.com` |
| Details | Scheme / Forward Hostname / Port | `http` / `ferry` / `8080` |
| SSL | SSL Certificate | Request a new certificate (or pick yours) |
| SSL | Force SSL | on |

Save, and check that `https://rustdesk.example.com` opens the web client.

## 3. Find the certificate's folder

The WebSocket ports reuse that certificate. List NPM's certificates:

```sh
docker exec <npm container> ls /etc/letsencrypt/live/
```

Each certificate has a folder `npm-<number>`, where the number is the certificate's ID. Pick
the one for this hostname. With several, the newest has the highest number, or check the
certificate's ID in NPM's SSL Certificates page.

A certificate you uploaded yourself lives in `/data/custom_ssl/npm-<number>/` instead.

## 4. The WebSocket listeners

Create `data/nginx/custom/http.conf`: `data` is the folder mounted at `/data`. If the file
already exists, append this to it. Replace `rustdesk.example.com` and `npm-1`:

```nginx
# hbbs WebSocket (ID server)
server {
    listen 21118 ssl;
    listen [::]:21118 ssl;
    server_name rustdesk.example.com;
    ssl_certificate     /etc/letsencrypt/live/npm-1/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/npm-1/privkey.pem;

    location / {
        proxy_pass http://hbbs:21118;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
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
    ssl_certificate     /etc/letsencrypt/live/npm-1/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/npm-1/privkey.pem;

    location / {
        proxy_pass http://hbbr:21119;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}
```

Then restart NPM (`docker restart <npm container>`). If NPM stops responding, check
`docker logs <npm container>` for an nginx error in this file.

**Certificate renewals:** NPM renews certificates in place, in the same folder, so this file
keeps working. NPM reloads nginx after a renewal, which picks up the new certificate on these
ports too.

Next: back to [the README, step 5](../../README.md#set-it-up).
