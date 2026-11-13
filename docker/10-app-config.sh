#!/bin/sh
# 10-app-config.sh: write the app's runtime settings, /run/rustdesk-web/config.js, from the
# environment at container start (nginx:alpine runs /docker-entrypoint.d/*.sh before nginx).
# The values are validated so nothing but a host[:port] and a base64 key can reach the script.
# RUSTDESK_ID_SERVER required ID server as given to RustDesk clients, e.g. rustdesk-id.example.com:441
# RUSTDESK_KEY required contents of hbbs's id_ed25519.pub
# RUSTDESK_WEB_CONFIG_DIR optional default /run/rustdesk-web (must be writable: tmpfs)
set -eu
die() { echo "10-app-config: ERROR: $*" >&2; exit 1; }
DIR=${RUSTDESK_WEB_CONFIG_DIR:-/run/rustdesk-web}
ID=${RUSTDESK_ID_SERVER:-}
KEY=${RUSTDESK_KEY:-}
[ -n "$ID" ] || die "RUSTDESK_ID_SERVER is empty (set it in .env)"
[ -n "$KEY" ] || die "RUSTDESK_KEY is empty (contents of id_ed25519.pub)"
echo "$ID" | grep -Eq '^[A-Za-z0-9.-]+(:[0-9]{1,5})?$' || die "RUSTDESK_ID_SERVER must be host or host:port"
echo "$KEY" | grep -Eq '^[A-Za-z0-9+/]{43}=$' || die "RUSTDESK_KEY must be a 32-byte base64 key"
mkdir -p "$DIR"
printf 'window.RUSTDESK_WEB_CONFIG = {"idServer":"%s","key":"%s"};\n' "$ID" "$KEY" > "$DIR/config.js"
echo "10-app-config: wrote $DIR/config.js (id server $ID)" >&2
