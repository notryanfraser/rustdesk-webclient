# syntax=docker/dockerfile:1
# rustdesk-web image: the Preact UI and the TypeScript core, served by nginx (non-root, port 8080).
# Build context: the repository root:   docker build -f docker/Dockerfile .

# ---------------------------------------------------------------- build stage
# The build output is plain JS: build once, natively, for every target platform.
FROM --platform=$BUILDPLATFORM node:22.23.0-alpine AS build
WORKDIR /src
# Dependencies first (cached unless a lockfile changes). Exact versions, from the lockfiles.
COPY core/package.json core/package-lock.json core/
COPY app/package.json app/package-lock.json app/
RUN cd core && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && cd ../app && npm ci --ignore-scripts --no-audit --no-fund
COPY core/src core/src
COPY app/build.mjs app/tsconfig.json app/
COPY app/src app/src
RUN cd app && node build.mjs && test -f dist/app.js && test -f dist/video-worker.js && test -s dist/audio-worklet.js

# --------------------------------------------------------------- final stage
FROM nginx:1.30.6-alpine
# Copies only, no RUN: every target platform builds without emulation.
# Non-root: nginx-main.conf has no `user` line and keeps its pid file in /tmp; listens on 8080.
COPY docker/nginx-main.conf /etc/nginx/nginx.conf
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/app/dist/ /usr/share/nginx/html/rustdesk/
COPY --chmod=755 docker/10-app-config.sh /docker-entrypoint.d/10-app-config.sh
USER nginx
EXPOSE 8080
