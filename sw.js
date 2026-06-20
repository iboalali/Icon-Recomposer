// sw.js — service worker: makes Icon Recomposer installable and fully offline.
//
// Hand-rolled (no Workbox) to keep the project dependency-free. Strategy:
//   - install: precache the whole app shell (it's a small, fixed file set).
//   - fetch:   cache-first for same-origin GETs (instant + offline); fall back
//              to the network and cache new same-origin responses. Cross-origin
//              requests (e.g. the TelemetryDeck CDN) are left to the network and
//              simply no-op offline.
//   - activate: delete caches from older versions.
//
// Versioning: the page registers this script as `sw.js?v=<APP_VERSION>`, so each
// release URL is unique → the browser installs a fresh worker, and we name the
// cache by that version (read from our own URL). Bumping APP_VERSION in model.js
// is therefore the ONLY release step needed to ship a new cached build.
//
// MAINTENANCE: when you add a new top-level file the app loads (a new ES module,
// asset, etc.), add it to PRECACHE below or it won't be available offline.

const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `icon-recomposer-${VERSION}`;

// App shell — paths are relative to the SW scope (the deploy subdirectory).
const PRECACHE = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  // ES modules
  'ui.js',
  'model.js',
  'derive.js',
  'svg.js',
  'export-vd.js',
  'export-png.js',
  'import.js',
  'color.js',
  'colorpicker.js',
  'dialog.js',
  'path.js',
  'telemetry.js',
  // icons / manifest assets
  'assets/favicon-64.png',
  'assets/brand-64.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/icon-512-maskable.png',
  'assets/apple-touch-icon.png',
  // default project fetched on first load
  'assets/app%20icon.json',
];

self.addEventListener('install', (event) => {
  // Precache the shell. addAll is atomic — if any file 404s the install fails,
  // which surfaces a missing PRECACHE entry early rather than shipping broken.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('icon-recomposer-') && k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let cross-origin hit the network

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Cache successful basic responses for next time (runtime fill-in).
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline and not cached: for navigations, fall back to the app shell.
          if (req.mode === 'navigate') return caches.match('index.html');
          return Response.error();
        });
    })
  );
});

// The page tells a waiting worker to take over immediately (update prompt).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
