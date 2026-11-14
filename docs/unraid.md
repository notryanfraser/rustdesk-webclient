# Unraid

Ferry is one small container. You don't need Docker Compose: you almost certainly already run
hbbs and hbbr, so you only add Ferry and a reverse proxy in front of all three.

## 1. Install the template

Until Ferry is in Community Apps, add the template by hand:

1. Open the Unraid terminal (or SSH in) and download the template:

   ```sh
   wget -O /boot/config/plugins/dockerMan/templates-user/ferry.xml \
     https://raw.githubusercontent.com/notryanfraser/ferry/main/unraid/ferry.xml
   ```

2. In the Unraid web UI, open **Docker**, click **Add Container**, and pick **Ferry** under
   *User templates* in the **Template** list.
3. Fill in the two settings:

   | Setting | Value |
   |---|---|
   | **ID server** | Your RustDesk server's address as native clients write it, e.g. `rustdesk.example.com` |
   | **Key** | The contents of `id_ed25519.pub` from hbbs's data folder, e.g. `/mnt/user/appdata/hbbs/id_ed25519.pub` |

4. Click **Apply**. The template's extra parameters make the container read-only and drop
   its privileges; leave them in place.

The page is now at `http://<unraid-ip>:8080/rustdesk/`. It will load but not connect until
the proxy below is in place.

## 2. Put a reverse proxy in front

Browsers need TLS (`wss://`) to reach hbbs and hbbr, so one hostname needs three TLS
ports on your proxy:

| Browser connects to | Proxy forwards to |
|---|---|
| `https://rustdesk.example.com` | Ferry, port 8080 |
| `wss://rustdesk.example.com:21118` | hbbs, port 21118 |
| `wss://rustdesk.example.com:21119` | hbbr, port 21119 |

Use the guide for the proxy you run. On Unraid that is usually
[Nginx Proxy Manager](proxy/nginx-proxy-manager.md) or SWAG ([nginx](proxy/nginx.md)).

Two Unraid details:

- **Container names:** the guides forward to `ferry`, `hbbs` and `hbbr`. Use your containers'
  names, or the server's IP and the ports, instead. By name only works when the proxy and the
  targets share a custom Docker network.
- **Ports 21118 and 21119:** if your hbbs/hbbr container publishes them on the host (for
  example with host networking), your proxy can't also listen on them on the same IP.
  Give the proxy its own IP (a custom network, such as `br0`), or stop publishing those two
  ports and let the proxy reach them over a shared Docker network.

## 3. Check hbbs's relay setting

hbbs's `-r` setting must be a hostname your proxy has a certificate for. See
[Troubleshooting](../README.md#troubleshooting) if the app finds a remote but can't connect.
