/* SnapZ service worker — the app shell works with no connection at all.
   Photos come from R2 and are cached on first view; only failed uploads are
   held locally, in the outbox. */

const VERSION = 'snapz-v15';
const SHELL = [
  '/',
  '/index.html',
  '/lock',
  '/lock.html',
  '/gallery',
  '/gallery.html',
  '/styles.css',
  '/shared.js',
  '/api.js',
  '/camera.js',
  '/gallery.js',
  '/login.js',
  '/enhance.js',
  '/worker.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  /* One missing entry must not fail the whole install — addAll is all-or-nothing. */
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
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

  /* Navigations: offline, fall back to the matching page shell. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(async () => {
        const c = await caches.open(VERSION);
        const p = url.pathname;
        return (await c.match(p)) ||
               (await c.match(p.replace(/\/$/, '') + '.html')) ||
               (await c.match('/')) ||
               Response.error();
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

/* ---------- Background Sync ----------
   The browser replays this even if SnapZ is closed, so a failed upload is no
   longer hostage to you reopening the app. */
const DB = 'snapz-outbox', OUTBOX = 'outbox', META = 'meta';

const openDB = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 3);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const store = async (name, mode, fn) => {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(name, mode), out = fn(t.objectStore(name));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
};

async function drainOutbox() {
  let token = '', api = '';
  try {
    token = (await store(META, 'readonly', s => s.get('token')))?.v || '';
    api   = (await store(META, 'readonly', s => s.get('api')))?.v || '';
  } catch { return; }
  if (!token || !api) return;

  const pending = await store(OUTBOX, 'readonly', s => s.getAll()).catch(() => []);
  for (const rec of pending) {
    const fd = new FormData();
    fd.set('image', rec.blob, `${rec.day}.webp`);
    if (rec.thumb) fd.set('thumb', rec.thumb, `${rec.day}-t.webp`);
    fd.set('day', rec.day);
    fd.set('ts', String(rec.ts));
    fd.set('time', new Date(rec.ts).toTimeString().slice(0, 8));
    if (rec.lat != null) { fd.set('lat', rec.lat); fd.set('lon', rec.lon); }
    if (rec.acc != null) fd.set('accuracy', rec.acc);
    if (rec.place) fd.set('place', rec.place);
    if (rec.w) { fd.set('width', rec.w); fd.set('height', rec.h); }

    const res = await fetch(`${api}/api/snap`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd
    }).catch(() => null);

    if (res && res.ok) await store(OUTBOX, 'readwrite', s => s.delete(rec.qid));
    else throw new Error('retry later');      // keeps the sync registration alive
  }
}

self.addEventListener('sync', e => {
  if (e.tag === 'snapz-outbox') e.waitUntil(drainOutbox());
});

/* Let the page trigger a sync attempt when it regains connectivity. */
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
