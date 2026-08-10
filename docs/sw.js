// Minimal offline cache for the app shell. Deliberately does NOT try to cache
// third-party CDN assets (Leaflet) or the NOAA/USGS APIs — live-data caching
// and staleness labeling is handled in app.js via localStorage, which knows
// the difference between "stale" and "current" and can say so in the UI. A
// service worker cache can't make that distinction, so keeping it scoped to
// same-origin shell files avoids ever silently serving stale API data as if
// it were fresh.

// Bump the version suffix on any deploy that changes shell/data content —
// it forces old cached entries (keyed by these exact URLs) to be dropped in
// the activate handler below instead of silently lingering. Keep in sync
// with the ?v= query params in index.html and DATA_VERSION in app.js.
const CACHE_NAME = 'river-clearance-shell-v20260810c';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css?v=20260810c',
  './app.js?v=20260810c',
  './data/bridges.json?v=20260810c',
  './data/gauges.json?v=20260810c',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let CDN/API requests pass through untouched

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
