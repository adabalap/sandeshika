/*
 * Offline shell.
 *
 * STRATEGY: network-first for app code, cache only as an offline fallback.
 *
 * The first version was cache-first with a hard-coded cache name. That is the
 * textbook approach and it was wrong here: the cache name never changed, so a
 * device kept serving the JS it downloaded on day one. Every later fix was
 * invisible on the phone while looking correct in the repo, and days were spent
 * debugging behaviour that the device was not running.
 *
 * Network-first costs one conditional request per asset when online — the
 * server answers 304 and nothing is transferred — and guarantees the code on
 * screen is the code that was shipped. Offline still works from the cache.
 */
const VERSION = '2.1.0';
const CACHE = `sandeshika-${VERSION}`;

/*
 * The full module graph. index.html loads one entry point, but a module import
 * is a separate request, so every module must be here or the app is only
 * partially available offline — which fails in the most confusing way possible:
 * the shell paints and then nothing works.
 *
 * Kept in sync with static/js/ by tests/shell.test.js, which walks the imports
 * and fails if this list drifts.
 */
const SHELL = [
  '/',
  '/static/app.css',
  '/manifest.webmanifest',
  '/static/icons/icon.svg',
  '/static/icons/icon-192.png',

  '/static/js/main.js',

  '/static/js/core/format.js',
  '/static/js/core/provenance.js',
  '/static/js/core/redact.js',
  '/static/js/core/analytics.js',
  '/static/js/core/parser.js',
  '/static/js/core/organizer.js',
  '/static/js/core/model.js',

  '/static/js/data/transport.js',
  '/static/js/data/client.js',
  '/static/js/data/categories.js',
  '/static/js/data/ingest.js',

  '/static/js/ui/dom.js',
  '/static/js/ui/state.js',
  '/static/js/ui/theme.js',
  '/static/js/ui/errors.js',
  '/static/js/ui/components.js',
  '/static/js/ui/actions.js',

  '/static/js/ui/views/overview.js',
  '/static/js/ui/views/dashboard.js',
  '/static/js/ui/views/daily.js',
  '/static/js/ui/views/detail.js',
  '/static/js/ui/views/transactions.js',
  '/static/js/ui/views/bills.js',
  '/static/js/ui/views/inbox.js',
  '/static/js/ui/views/ask.js',
  '/static/js/ui/views/setup.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Individually, so one missing file cannot fail the whole install and
      // leave the previous worker in charge indefinitely.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'version') {
    e.source.postMessage({ swVersion: VERSION });
  }
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Live data and server state are never cached: a stale balance is worse than
  // an error, and a cached /config.json hides a settings change.
  if (url.pathname.startsWith('/api') || url.pathname === '/config.json'
      || url.pathname === '/settings' || url.pathname === '/detect') return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit
        || new Response('Offline and not cached', { status: 503 })))
  );
});
