/* Cloud client. The gallery is served entirely from D1 + R2 — this module is
   the only thing that talks to the network. */

const TKEY = 'snapz_token', AKEY = 'snapz_api', IKEY = 'snapz_index';
const OUTBOX = 'outbox', META = 'meta';
const DEFAULT_API = 'https://snapz-api.xxzeeshanahmedxx.workers.dev';
const INDEX_CAP = 60;            // localStorage is ~5 MB; never court the quota
const OUTBOX_CAP = 20;           // failed uploads must not grow without bound

export const apiBase  = () => (localStorage.getItem(AKEY) || DEFAULT_API).replace(/\/$/, '');
export const setApi   = u => localStorage.setItem(AKEY, u.replace(/\/$/, ''));
export const getToken = () => localStorage.getItem(TKEY) || '';
export const setToken = t => { localStorage.setItem(TKEY, t); putMeta('token', t); };
export const logout   = () => { localStorage.removeItem(TKEY); putMeta('token', ''); };

const auth = () => ({ authorization: `Bearer ${getToken()}` });

/* Anything that writes to localStorage must survive a full quota. */
function save(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch { try { localStorage.removeItem(key); } catch {} return false; }
}

/* ---------- auth ---------- */
export const status = () => fetch(`${apiBase()}/api/auth/status`).then(r => r.json());

export async function login(passcode) {
  const r = await fetch(`${apiBase()}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode })
  });
  const d = await r.json();
  if (!r.ok) { const e = new Error(d.error || 'login failed'); e.retryAfter = d.retryAfter; throw e; }
  setToken(d.token);
  await putMeta('api', apiBase());
  return d;
}

export async function changePasscode(current, next) {
  const r = await fetch(`${apiBase()}/api/auth/change`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ current, next })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'failed');
  setToken(d.token);
  return d;
}

/* ---------- the viewing window (the server owns it) ---------- */
export const WKEY = 'snapz_window';
export async function getWindow() {
  const r = await fetch(`${apiBase()}/api/window`, { headers: auth() });
  if (!r.ok) throw new Error('window');
  const w = await r.json();
  save(WKEY, JSON.stringify(w));
  return w;
}
export async function setWindow(patch) {
  const r = await fetch(`${apiBase()}/api/window`, {
    method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(patch)
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'failed');
  const w = await r.json();
  save(WKEY, JSON.stringify(w));
  return w;
}

/* ---------- snaps ---------- */
export class Closed extends Error { constructor(w) { super('closed'); this.window = w; } }

/* One page at a time. `before` is the ts cursor returned by the previous page. */
export async function list({ limit = 60, before = null } = {}) {
  const u = new URL(`${apiBase()}/api/snaps`);
  u.searchParams.set('limit', limit);
  if (before) u.searchParams.set('before', before);
  const r = await fetch(u, { headers: auth() });
  if (r.status === 423) throw new Closed((await r.json().catch(() => ({}))).window);
  if (r.status === 401) throw new Error('unauthorized');
  if (!r.ok) throw new Error(`list failed ${r.status}`);
  const d = await r.json();
  if (!before) save(IKEY, JSON.stringify(d.snaps.slice(0, INDEX_CAP)));
  return d;
}
export const cachedList = () => {
  try { return JSON.parse(localStorage.getItem(IKEY)) || []; } catch { return []; }
};
export const cacheList = snaps => save(IKEY, JSON.stringify(snaps.slice(0, INDEX_CAP)));

export const trash = () =>
  fetch(`${apiBase()}/api/trash`, { headers: auth() }).then(r => r.json());

export async function upload({ day, ts, blob, thumb, lat, lon, acc, place, w, h }, onProgress) {
  const fd = new FormData();
  fd.set('image', blob, `${day}.webp`);
  if (thumb) fd.set('thumb', thumb, `${day}-t.webp`);
  fd.set('day', day);
  fd.set('ts', String(ts));
  fd.set('time', new Date(ts).toTimeString().slice(0, 8));
  fd.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  if (lat != null) { fd.set('lat', lat); fd.set('lon', lon); }
  if (acc != null) fd.set('accuracy', acc);
  if (place) fd.set('place', place);
  if (w) { fd.set('width', w); fd.set('height', h); }

  /* XHR, not fetch: it is the only way to get real upload progress, and a
     progress bar that reflects actual bytes is the difference between a
     reassurance and a lie. */
  const d = await new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${apiBase()}/api/snap`);
    x.setRequestHeader('authorization', `Bearer ${getToken()}`);
    x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) res(j);
      else rej(new Error(j.error || `upload failed ${x.status}`));
    };
    x.onerror = () => rej(new Error('network'));
    x.ontimeout = () => rej(new Error('timed out'));
    x.timeout = 180000;
    x.send(fd);
  });
  onProgress?.(1);
  return d.snap;
}

/* Soft delete — recoverable for 30 days. */
export const remove  = id => fetch(`${apiBase()}/api/snap/${encodeURIComponent(id)}`,
  { method: 'DELETE', headers: auth() }).then(r => r.json());
export const restore = id => fetch(`${apiBase()}/api/snap/${encodeURIComponent(id)}/restore`,
  { method: 'POST', headers: auth() }).then(r => r.json());

/* ---------- outbox: survives being offline ----------
   Only failed uploads are kept locally, and only until they land. The gallery
   never reads from here. Keyed per snap, not per day. */
const idb = indexedDB.open('snapz-outbox', 3);
idb.onupgradeneeded = () => {
  const db = idb.result;
  if (db.objectStoreNames.contains('snapz_outbox')) db.deleteObjectStore('snapz_outbox');
  if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'qid' });
  if (!db.objectStoreNames.contains(META))   db.createObjectStore(META,   { keyPath: 'k' });
};
const db = new Promise(res => { idb.onsuccess = () => res(idb.result); });
const tx = async (store, mode, fn) => {
  const d = await db;
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), out = fn(t.objectStore(store));
    t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error);
  });
};

/* The service worker cannot read localStorage, so mirror what it needs. */
export const putMeta = (k, v) => tx(META, 'readwrite', s => s.put({ k, v })).catch(() => {});

export const pending = () => tx(OUTBOX, 'readonly', s => s.getAll());
export const unqueue = qid => tx(OUTBOX, 'readwrite', s => s.delete(qid));
export async function queue(rec) {
  if (!rec.qid) rec.qid = `${rec.day}-${rec.ts}-${Math.random().toString(36).slice(2,7)}`;
  await tx(OUTBOX, 'readwrite', s => s.put(rec));
  const all = await pending();
  if (all.length > OUTBOX_CAP) {            // drop the oldest, never grow forever
    const old = all.sort((a, b) => a.ts - b.ts).slice(0, all.length - OUTBOX_CAP);
    for (const o of old) await unqueue(o.qid);
  }
  /* Hand the retry to the browser: it will fire even if the app is closed. */
  try {
    const reg = await navigator.serviceWorker?.ready;
    await reg?.sync?.register('snapz-outbox');
  } catch {}
  return rec.qid;
}

export async function flush(onProgress) {
  if (!navigator.onLine || !getToken()) return 0;
  let sent = 0;
  for (const rec of await pending()) {
    try { await upload(rec, onProgress); await unqueue(rec.qid); sent++; }
    catch (e) {
      /* Record the failure instead of hiding it — the UI shows the count. */
      rec.tries = (rec.tries || 0) + 1;
      rec.lastError = String(e.message || e);
      await tx(OUTBOX, 'readwrite', s => s.put(rec));
      break;                            // still offline / server down — try later
    }
  }
  return sent;
}
