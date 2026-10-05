// Minimal service worker: makes fakktura installable and lets the app shell
// open without a connection. Network first, so a new deploy is picked up on
// the next load; the cache is only a fallback. Lookups (/api and the
// operators' own APIs) are never cached here.

const CACHE = "fakktura-shell-v1";
const SHELL = [
  "./",
  "styles.css",
  "config.js",
  "providers.js",
  "app.js",
  "favicon.svg",
  "fonts/inter-latin.woff2",
  "fonts/jetbrains-mono-700-latin.woff2",
  "icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(request);
      if (res.ok) {
        const copy = res.clone();
        // Store pages under "./" so any ?plate=… URL can fall back to the shell.
        const key = request.mode === "navigate" ? "./" : request;
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    } catch (err) {
      const cached = await caches.match(request.mode === "navigate" ? "./" : request);
      if (cached) return cached;
      throw err;
    }
  })());
});
