// sw.js · RoughCut
// App-shell precache. Bump CACHE on every deploy to match the version badge.
// Media lives in OPFS (not fetched), so it is never cached here.
const CACHE = 'roughcut-v03';

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
  'ui.js',
  'mediabunny.js',
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

  // Navigations: serve cached shell, fall back to network, then index.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('index.html').then((cached) => cached || fetch(req).catch(() => caches.match('index.html')))
    );
    return;
  }

  // Everything else: cache-first, fill cache on miss.
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
