/* Shared by all three pages: /lock, / (camera), /gallery */

export const $ = id => document.getElementById(id);
export const inFrame = window.self !== window.top;

/* ---------- motion ---------- */
export const SPRING = 'cubic-bezier(.22,1.2,.36,1)';
export const SNAP   = 'cubic-bezier(.2,.9,.3,1)';
export const still  = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- the open window ----------
   The SERVER owns this now: it refuses to list snaps or serve images outside
   the window, so moving the phone's clock no longer helps. What follows is a
   local mirror, used only to decide what to draw. */
export const WKEY = 'snapz_window', HKEY = 'snapz_hours';
export const DEFAULT_WIN = { from: '18:00', to: '21:00', lift: false };

export function win() {
  try { return { ...DEFAULT_WIN, ...(JSON.parse(localStorage.getItem(WKEY)) || {}) }; }
  catch { return { ...DEFAULT_WIN }; }
}
const toMins = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1]*60 + +m[2] : 0; };
const nowMins = (d = new Date()) => d.getHours() * 60 + d.getMinutes();

export const windowMins = () => { const w = win(); return [toMins(w.from), toMins(w.to)]; };
export const hhmm = t => {
  const d = new Date(); d.setHours(Math.floor(t / 60) % 24, t % 60, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
export const windowLabel = () => { const [o, c] = windowMins(); return `${hhmm(o)} – ${hhmm(c)}`; };

/* Handles a window that runs past midnight (22:00–02:00) as well. */
export function inWindow(d = new Date()) {
  const [o, c] = windowMins(), t = nowMins(d);
  return o <= c ? (t >= o && t < c) : (t >= o || t < c);
}
export const lifted = () => win().lift === true;
export const isOpen = (d) => lifted() || inWindow(d);
export const locked = () => !isOpen();

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
