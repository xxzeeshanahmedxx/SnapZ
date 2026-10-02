/* Cloud client. The gallery is served entirely from D1 + R2 — this module is
   the only thing that talks to the network. */

const TKEY = 'snapz_token', AKEY = 'snapz_api', OUTBOX = 'outbox';
const DEFAULT_API = 'https://snapz-api.xxzeeshanahmedxx.workers.dev';

export const apiBase  = () => (localStorage.getItem(AKEY) || DEFAULT_API).replace(/\/$/, '');
export const setApi   = u => localStorage.setItem(AKEY, u.replace(/\/$/, ''));
export const getToken = () => localStorage.getItem(TKEY) || '';
export const setToken = t => localStorage.setItem(TKEY, t);
export const logout   = () => localStorage.removeItem(TKEY);

const auth = () => ({ authorization: `Bearer ${getToken()}` });

/* ---------- auth ---------- */
export const status = () => fetch(`${apiBase()}/api/auth/status`).then(r => r.json());

export async function login(passcode) {
  const r = await fetch(`${apiBase()}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'login failed');
  setToken(d.token);
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

/* ---------- snaps ---------- */
export async function list() {
  const r = await fetch(`${apiBase()}/api/snaps`, { headers: auth() });
  if (!r.ok) throw new Error(r.status === 401 ? 'unauthorized' : `list failed ${r.status}`);
  const { snaps } = await r.json();
  localStorage.setItem('snapz_index', JSON.stringify(snaps));   // for instant paint
  return snaps;
}
export const cachedList = () => {
  try { return JSON.parse(localStorage.getItem('snapz_index')) || []; } catch { return []; }
};

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
    x.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
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

export async function remove(day) {
  await fetch(`${apiBase()}/api/snap/${day}`, { method: 'DELETE', headers: auth() });
}

/* ---------- outbox: survives being offline ----------
   Only failed uploads are kept locally, and only until they land. The gallery
   never reads from here. Keyed per snap, not per day — several a day is normal. */
const idb = indexedDB.open('snapz-outbox', 2);
idb.onupgradeneeded = e => {
  const db = idb.result;
  if (db.objectStoreNames.contains('snapz_outbox')) db.deleteObjectStore('snapz_outbox');
  if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX, { keyPath: 'qid' });
};
const db = new Promise(res => { idb.onsuccess = () => res(idb.result); });
const tx = async (mode, fn) => {
  const d = await db;
  return new Promise((res, rej) => {
    const t = d.transaction(OUTBOX, mode), out = fn(t.objectStore(OUTBOX));
    t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error);
  });
};
export const queue    = rec => tx('readwrite',
  s => s.put(rec.qid ? rec : Object.assign(rec, { qid: `${rec.day}-${rec.ts}-${Math.random().toString(36).slice(2,7)}` })));
export const unqueue  = qid => tx('readwrite', s => s.delete(qid));
export const pending  = () => tx('readonly', s => s.getAll());

export async function flush(onProgress) {
  if (!navigator.onLine || !getToken()) return 0;
  let sent = 0;
  for (const rec of await pending()) {
    try { await upload(rec, onProgress); await unqueue(rec.qid); sent++; }
    catch (e) {
      /* Record the failure instead of hiding it — the UI shows the count. */
      rec.tries = (rec.tries || 0) + 1;
      rec.lastError = String(e.message || e);
      await queue(rec);
      break;                            // still offline / server down — try later
    }
  }
  return sent;
}
