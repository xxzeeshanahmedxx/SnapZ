/* SnapZ app lock — for phones other people use.
   A PIN only you know. Never stored: only a PBKDF2 hash, locally.
   Deliberately independent of the OS biometrics, because on a shared device
   the enrolled finger may not be yours. */

const KEY   = 'snapz_pin';        // {salt, hash, iter}
const FAILS = 'snapz_pin_fails';
const MODE  = 'snapz_lock_when';  // 'instant' | 'minute' | 'never'

const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

async function derive(pin, saltHex, iter = 150000) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const k = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, k, 256));
}

export const isSet = () => !!localStorage.getItem(KEY);
export const lockWhen = () => localStorage.getItem(MODE) || 'instant';
export const setLockWhen = v => localStorage.setItem(MODE, v);

export async function setPin(pin) {
  if (!/^\d{4,}$/.test(pin) && String(pin).length < 4)
    throw new Error('PIN must be at least 4 characters');
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derive(String(pin), salt);
  localStorage.setItem(KEY, JSON.stringify({ salt, hash, iter: 150000 }));
  localStorage.removeItem(FAILS);
}

export async function changePin(current, next) {
  if (!(await verify(current))) throw new Error('Wrong PIN');
  await setPin(next);
}

export function clearPin() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(FAILS);
}

/* constant-time-ish compare */
const same = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export async function verify(pin) {
  const raw = localStorage.getItem(KEY);
  if (!raw) return true;
  const { salt, hash, iter } = JSON.parse(raw);
  const ok = same(await derive(String(pin), salt, iter), hash);
  if (ok) localStorage.removeItem(FAILS);
  else {
    const n = fails() + 1;
    localStorage.setItem(FAILS, JSON.stringify({ n, at: Date.now() }));
  }
  return ok;
}

/* ---- throttling: brute force gets slow fast ---- */
export function fails() {
  try { return JSON.parse(localStorage.getItem(FAILS))?.n || 0; } catch { return 0; }
}
export function lockedOutFor() {
  let f;
  try { f = JSON.parse(localStorage.getItem(FAILS)); } catch { return 0; }
  if (!f || f.n < 3) return 0;
  const wait = Math.min(300, 2 ** (f.n - 2)) * 1000;   // 2s,4s,8s… capped at 5 min
  return Math.max(0, f.at + wait - Date.now());
}
