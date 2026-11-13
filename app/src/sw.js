// Service worker: makes the app installable and lets its shell load offline. Network first
// for everything: online, the app is always the deployed version (nginx serves it no-cache) and
// the cache is only refreshed; offline, the cached shell loads (connecting then fails with the
// usual network message). Only same-origin GETs in this scope; the WebSockets to hbbs/hbbr never
// pass through a service worker. build.mjs fills in VERSION (a hash of the shell) and SHELL.
const VERSION = "__VERSION__";
const SHELL = __SHELL__;
const CACHE = `rustdesk-web-${VERSION}`;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("rustdesk-web-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    !req.url.startsWith(self.registration.scope)
  )
    return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(
        async () =>
          (await caches.match(req, { ignoreSearch: true })) ??
          (req.mode === "navigate" ? caches.match("./") : Response.error()),
      ),
  );
});
