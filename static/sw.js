/*
 * Offline shell. The app must work in airplane mode: Medha is on loopback, so
 * the ONLY thing a network outage can break is loading these static files.
 * Cache-first for the shell, never for API calls.
 */
const CACHE = 'sandeshika-v1';
const SHELL = [
  '/', '/static/app.css',
  '/static/js/parser.js', '/static/js/api.js', '/static/js/app.js',
  '/manifest.webmanifest', '/static/icons/icon.svg', '/static/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache Medha responses: stale financial data is worse than an error.
  // Everything under /api is proxied live data; caching it would show stale
  // balances. /config.json reflects server state and must not be cached either.
  const isApi = url.pathname.startsWith('/api') || url.pathname === '/config.json';
  if (isApi || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
