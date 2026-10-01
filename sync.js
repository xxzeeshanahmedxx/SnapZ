/* SnapZ cloud sync — offline-first.
   The local IndexedDB copy is always written first and is never blocked by the
   network. This module pushes each day's photo up to the Worker (D1 + R2) in
   the background and retries whatever failed. */

const API   = localStorage.getItem('snapz_api') || 'https://snapz-api.xxzeeshanahmedxx.workers.dev';
const QKEY  = 'snapz_queue';
const TKEY  = 'snapz_token';

export const getToken = () => localStorage.getItem(TKEY) || '';
export const setToken = t => localStorage.setItem(TKEY, t);
export const setApi   = u => localStorage.setItem('snapz_api', u.replace(/\/$/, ''));
export const apiBase  = () => (localStorage.getItem('snapz_api') || API).replace(/\/$/, '');

const queue = () => { try { return JSON.parse(localStorage.getItem(QKEY)) || []; } catch { return []; } };
const setQueue = q => localStorage.setItem(QKEY, JSON.stringify([...new Set(q)]));

/* ---- upload one record ---- */
export async function upload(rec) {
  const token = getToken();
  if (!token) throw Object.assign(new Error('no token'), { code: 'NO_TOKEN' });

  const d = new Date(rec.ts);
  const fd = new FormData();
  fd.set('image', rec.blob, `${rec.day}.${(rec.type || 'image/webp').split('/')[1]}`);
  fd.set('day', rec.day);
  fd.set('ts', String(rec.ts));
  fd.set('time', d.toTimeString().slice(0, 8));
  fd.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  if (rec.lat != null) { fd.set('lat', rec.lat); fd.set('lon', rec.lon); }
  if (rec.acc != null) fd.set('accuracy', rec.acc);
  if (rec.place) fd.set('place', rec.place);
  if (rec.w) { fd.set('width', rec.w); fd.set('height', rec.h); }

  const r = await fetch(`${apiBase()}/api/snap`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd
  });
  if (r.status === 401) throw Object.assign(new Error('bad token'), { code: 'UNAUTHORIZED' });
  if (!r.ok) throw new Error(`upload failed: ${r.status}`);
  return (await r.json()).snap;
}

/* ---- queue management ---- */
export function enqueue(day) { setQueue([...queue(), day]); }

export async function flush(getRecordForDay, onSynced) {
  if (!navigator.onLine || !getToken()) return;
  for (const day of queue()) {
    try {
      const rec = await getRecordForDay(day);
      if (!rec) { setQueue(queue().filter(d => d !== day)); continue; }
      const row = await upload(rec);
      setQueue(queue().filter(d => d !== day));
      onSynced?.(day, row);
    } catch (e) {
      if (e.code === 'NO_TOKEN' || e.code === 'UNAUTHORIZED') return;  // stop, wait for a token
      return;                                                          // network — try again later
    }
  }
}

export async function remoteList() {
  const r = await fetch(`${apiBase()}/api/snaps`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!r.ok) throw new Error(r.status);
  return (await r.json()).snaps;
}

export async function remoteDelete(day) {
  await fetch(`${apiBase()}/api/snap/${day}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${getToken()}` }
  });
}

export const pending = () => queue().length;
window.addEventListener('online', () => window.dispatchEvent(new Event('snapz:flush')));
