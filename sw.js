// sw.js · RoughCut
// App-shell precache. Bump CACHE on every deploy to match the version badge.
// Media lives in OPFS (not fetched), so it is never cached here.
const CACHE = 'roughcut-v32';

const CORE = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'favicon.svg',
  'app.js',
  'state.js',
  'media.js',
  'preview.js',
  'timeline.js',
  'ui.js',
  'audio.js',
  'extract.js',
  'text.js',
  'transitions.js',
  'export.js',
  'mediabunny.js',
  'creepster.woff2',
  'anton.woff2',
  'bebasneue.woff2',
  'caveat.woff2',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // IMPORTANT: only ever serve from the CURRENT version's cache (caches.open(CACHE)),
  // never caches.match(req) which searches EVERY cache and can hand back a file from an
  // older version. Serving a v21 module next to v24 modules is what made a half-updated
  // app throw on "open project" while trivial actions still worked. With current-cache-
  // only + the activate-time purge of old caches, cross-version file mixing can't happen.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.open(CACHE).then((c) => c.match('index.html')).then(
        (cached) => cached || fetch(req).catch(() => caches.open(CACHE).then((c) => c.match('index.html')))
      )
    );
    return;
  }

  e.respondWith(
    caches.open(CACHE).then((c) => c.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {});
        return res;
      });
    }))
  );
});
