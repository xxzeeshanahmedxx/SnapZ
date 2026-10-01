/* SnapZ service worker — the app shell works with no connection at all.
   Photos come from R2 and are cached on first view; only failed uploads are
   held locally, in the outbox. */

const VERSION = 'snapz-v7';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './enhance.js',
  './worker.js',
  './api.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Never cache the API — stale snaps would be worse than none. */
  if (url.pathname.startsWith('/api/')) return;

  /* Cloud images: cache-first, they're immutable once written. */
  if (url.pathname.startsWith('/i/')) {
    e.respondWith(
      caches.open(VERSION + '-img').then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  /* App shell: serve from cache instantly, refresh in the background. */
  e.respondWith(
    caches.open(VERSION).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => {
        if (res.ok && url.origin === location.origin) c.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

/* Let the page trigger a sync attempt when it regains connectivity. */
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
