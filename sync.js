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

/* ---- pull: bring the cloud archive down to this device ----
   Used on a new phone, after clearing data, or as a periodic reconcile.
   Local wins only when its capture is newer than the remote row. */
export async function pull({ hasDay, putDay, onProgress } = {}) {
  if (!getToken()) return { added: 0, updated: 0, skipped: 0 };
  const rows = await remoteList();
  let added = 0, updated = 0, skipped = 0, i = 0;

  for (const row of rows) {
    i++;
    onProgress?.(i, rows.length);
    const local = await hasDay(row.day);
    if (local && Number(local.ts) >= Number(row.ts)) { skipped++; continue; }

    let blob;
    try {
      const r = await fetch(row.url, { cache: 'force-cache' });
      if (!r.ok) throw new Error(r.status);
      blob = await r.blob();
    } catch { skipped++; continue; }

    await putDay({
      day: row.day,
      ts: Number(row.ts),
      lat: row.lat ?? null,
      lon: row.lon ?? null,
      acc: row.accuracy ?? null,
      place: row.place || '',
      type: row.mime || blob.type || 'image/webp',
      bytes: row.bytes || blob.size,
      w: row.width || null,
      h: row.height || null,
      blob,
      synced: true
    }, local);
    local ? updated++ : added++;
  }
  return { added, updated, skipped };
}

/* ---- passcode auth ---- */
export async function authStatus() {
  const r = await fetch(`${apiBase()}/api/auth/status`);
  if (!r.ok) throw new Error(r.status);
  return r.json();                       // { configured: bool }
}
export async function login(passcode) {
  const r = await fetch(`${apiBase()}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'login failed');
  setToken(d.token);                     // long-lived signed session token
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
export const logout = () => localStorage.removeItem(TKEY);

/* ================= PASSKEYS (fingerprint / Face ID) ================= */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(
  atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export const passkeySupported = () =>
  !!(window.PublicKeyCredential && navigator.credentials?.create);

export async function platformAvailable() {
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch { return false; }
}

export async function methods() {
  const r = await fetch(`${apiBase()}/api/auth/methods`);
  if (!r.ok) throw new Error(r.status);
  return r.json();                     // { passcode, passkeys, devices }
}

/* Enrol this device's fingerprint / Face ID. Requires a current session. */
export async function passkeyRegister(name) {
  const o = await (await fetch(`${apiBase()}/api/webauthn/register/options`, {
    method: 'POST', headers: { authorization: `Bearer ${getToken()}` }
  })).json();
  if (o.error) throw new Error(o.error);

  const cred = await navigator.credentials.create({ publicKey: {
    ...o,
    challenge: unb64u(o.challenge),
    user: { ...o.user, id: unb64u(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: unb64u(c.id) }))
  }});

  const r = await fetch(`${apiBase()}/api/webauthn/register/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({
      challenge: o.challenge,
      attestationObject: b64u(cred.response.attestationObject),
      clientDataJSON: b64u(cred.response.clientDataJSON),
      name: name || navigator.platform || 'This device'
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'registration failed');
  localStorage.setItem('snapz_lock', '1');
  return d;
}

/* Unlock with the fingerprint sensor. Returns a fresh session token. */
export async function passkeyLogin() {
  const o = await (await fetch(`${apiBase()}/api/webauthn/login/options`, { method: 'POST' })).json();
  if (o.error) throw new Error(o.error);

  const cred = await navigator.credentials.get({ publicKey: {
    ...o,
    challenge: unb64u(o.challenge),
    allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: unb64u(c.id) }))
  }});

  const r = await fetch(`${apiBase()}/api/webauthn/login/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challenge: o.challenge,
      id: cred.id,
      authenticatorData: b64u(cred.response.authenticatorData),
      clientDataJSON: b64u(cred.response.clientDataJSON),
      signature: b64u(cred.response.signature)
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'unlock failed');
  setToken(d.token);
  return d;
}

export const lockEnabled = () => localStorage.getItem('snapz_lock') === '1';
export const setLock = on => on ? localStorage.setItem('snapz_lock','1') : localStorage.removeItem('snapz_lock');

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
