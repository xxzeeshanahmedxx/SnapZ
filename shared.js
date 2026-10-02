/* Shared by all three pages: /lock, / (camera), /gallery */

export const $ = id => document.getElementById(id);
export const inFrame = window.self !== window.top;

/* ---------- motion ---------- */
export const SPRING = 'cubic-bezier(.22,1.2,.36,1)';
export const SNAP   = 'cubic-bezier(.2,.9,.3,1)';
export const still  = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- the open window ----------
   Photos are viewable during one window each day. Default 18:00–21:00.
   Stored as "HH:MM-HH:MM" so it reads plainly in devtools. */
export const HKEY = 'snapz_hours', DEFAULT_WINDOW = '18:00-21:00';
const nowMins = (d = new Date()) => d.getHours() * 60 + d.getMinutes();

export function windowMins() {
  const raw = localStorage.getItem(HKEY) || DEFAULT_WINDOW;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return [1080, 1260];
  return [Math.min(+m[1] * 60 + +m[2], 1439), Math.min(+m[3] * 60 + +m[4], 1440)];
}
export const hhmm = t => {
  const d = new Date(); d.setHours(Math.floor(t / 60) % 24, t % 60, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
export const windowLabel = () => { const [o, c] = windowMins(); return `${hhmm(o)} – ${hhmm(c)}`; };

/* Handles a window that runs past midnight (22:00–02:00) as well. */
export function isOpen(d = new Date()) {
  const [o, c] = windowMins(), t = nowMins(d);
  return o <= c ? (t >= o && t < c) : (t >= o || t < c);
}
export const TEST = 'snapz_testunlock';
export const lifted = () => localStorage.getItem(TEST) === '1';
export const locked = () => !isOpen() && !lifted();

export function nextOpen() {
  const [o] = windowMins(), d = new Date();
  d.setHours(0, 0, 0, 0); d.setMinutes(o);
  if (d <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}
export function nextClose() {
  const [o, c] = windowMins(), d = new Date();
  d.setHours(0, 0, 0, 0); d.setMinutes(c);
  if (o > c && nowMins() >= o) d.setDate(d.getDate() + 1);   // wraps midnight
  if (d <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

/* ---------- dates ---------- */
export const fmtDate  = ts => new Date(ts).toLocaleDateString(undefined, { weekday:'long', day:'numeric', month:'long', year:'numeric' });
export const fmtShort = ts => new Date(ts).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
export const fmtTime  = ts => new Date(ts).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
export const fmtMonth = ts => new Date(ts).toLocaleDateString(undefined, { month:'long', year:'numeric' });
export const dayKey   = ts => { const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export const today    = () => dayKey(Date.now());
export const mb = b => b >= 1073741824 ? (b/1073741824).toFixed(1) + ' GB' : (b/1048576).toFixed(1) + ' MB';

/* ---------- service worker ---------- */
export function registerSW() {
  if ('serviceWorker' in navigator)
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
