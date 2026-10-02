/* / — the camera. A viewfinder, a shutter, a flip, a thumbnail. Nothing else.
   Capture is never gated by the viewing window. */

import * as cloud from './api.js';
import { $, inFrame, SNAP, still, dayKey, registerSW, win, windowLabel } from './shared.js';

let stream = null, track = null, facing = 'user', busy = false, ready = false;

/* ---------- background image processor ---------- */
let worker = null, jobId = 0;
const jobs = new Map();
try {
  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = e => { const j = jobs.get(e.data.id);
    if (j) { jobs.delete(e.data.id); j(e.data.error ? null : e.data); } };
} catch {}
const process = bitmap => new Promise(res => {
  if (!worker) return res(null);
  const id = ++jobId; jobs.set(id, res);
  worker.postMessage({ id, bitmap }, [bitmap]);
  setTimeout(() => { if (jobs.has(id)) { jobs.delete(id); res(null); } }, 30000);
});

/* ---------- silent location ---------- */
let pos = null;
navigator.geolocation?.watchPosition(
  p => { pos = { lat:+p.coords.latitude.toFixed(6), lon:+p.coords.longitude.toFixed(6), acc:Math.round(p.coords.accuracy) }; },
  () => {}, { enableHighAccuracy:true, maximumAge:120000, timeout:20000 });

const placeName = async (lat, lon) => {
  try {
    const a = (await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${lat}&lon=${lon}`)).json()).address || {};
    return [a.suburb || a.neighbourhood || a.road, a.city || a.town || a.village || a.county, a.country].filter(Boolean).join(', ');
  } catch { return ''; }
};

/* ================= CAMERA ================= */
function fallback(msg, retry = true) {
  $('fallback').hidden = false; $('fbMsg').textContent = msg;
  $('fbRetry').hidden = !retry; $('fbTab').hidden = !inFrame;
  if (inFrame) $('fbTab').href = location.href;
  $('shutter').disabled = true; $('shutter').classList.add('off');
}

async function startCam() {
  stream?.getTracks().forEach(t => t.stop());
  stream = track = null;
  if (!window.isSecureContext) return fallback('Camera needs HTTPS.', false);
  if (!navigator.mediaDevices?.getUserMedia)
    return fallback(inFrame ? 'Camera is blocked in this preview frame.' : 'Camera not supported.', false);
  try {
    /* one axis only — constraining both squashes the sensor's aspect ratio */
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 3840 } }, audio: false });
    track = stream.getVideoTracks()[0];
    try {
      const c = track.getCapabilities?.() || {}, s = track.getSettings?.() || {};
      const ar = s.width && s.height ? s.width / s.height : null;
      const want = {};
      if (c.width?.max > (s.width || 0)) { want.width = c.width.max; if (ar) want.aspectRatio = ar; }
      const adv = ['focusMode','exposureMode','whiteBalanceMode']
        .filter(k => c[k]?.includes('continuous')).map(k => ({ [k]: 'continuous' }));
      if (adv.length) want.advanced = adv;
      if (Object.keys(want).length) await track.applyConstraints(want);
      const after = track.getSettings?.() || {};
      if (ar && after.width && Math.abs(after.width / after.height - ar) / ar > 0.02)
        await track.applyConstraints({ aspectRatio: ar });
    } catch {}
    const v = $('video');
    v.srcObject = stream; await v.play().catch(() => {});
    v.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';
    $('fallback').hidden = true;
    $('shutter').disabled = false; $('shutter').classList.remove('off');
    ready = true;                         // animations may start now
  } catch (e) {
    fallback({
      NotAllowedError: inFrame ? 'Camera blocked in this frame — open SnapZ in a tab.'
                               : 'Camera permission denied.',
      NotFoundError: 'No camera found.',
      NotReadableError: 'Camera is in use by another app.'
    }[e.name] || ('Camera error: ' + e.message));
  }
}
$('fbRetry').onclick = startCam;
$('flip').onclick = e => {
  e.currentTarget.classList.remove('turn'); void e.currentTarget.offsetWidth;
  e.currentTarget.classList.add('turn');
  facing = facing === 'user' ? 'environment' : 'user'; startCam();
};
$('shutter').onclick = () => capture();

/* ---------- the thumbnail is the status object ---------- */
const wrap = () => $('toGallery').parentElement;
const RING = 182.2;
function ring(state, p = 0) {
  const w = wrap();
  w.classList.toggle('busy',   state === 'saving' || state === 'uploading' || state === 'failed');
  w.classList.toggle('saving', state === 'saving');
  w.classList.toggle('failed', state === 'failed');
  w.classList.toggle('done',   state === 'done');
  $('ringFg').style.strokeDashoffset = state === 'saving' ? RING * 0.75
    : state === 'done' ? 0 : RING * (1 - p);
  $('ring').style.animation = state === 'saving' ? 'spin 1s linear infinite' : '';
  if (state === 'done') {
    navigator.vibrate?.([0, 12]);
    setTimeout(() => w.classList.remove('done', 'busy'), 1700);
  }
}

/* ---------- capture ---------- */
function toCanvas(src, w, h, mirror) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (mirror) { g.translate(w, 0); g.scale(-1, 1); }
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return cv;
}

/* the signature motion: the frame you just took flies into the thumbnail */
function fly(dataUrl) {
  if (still.matches || !ready) return;
  const v = $('video').getBoundingClientRect();
  const t = $('toGallery').getBoundingClientRect();
  const f = $('flight');
  f.hidden = false;
  f.style.backgroundImage = `url(${dataUrl})`;
  f.style.left = v.left + 'px'; f.style.top = v.top + 'px';
  f.style.width = v.width + 'px'; f.style.height = v.height + 'px';
  const k = Math.max(t.width / v.width, t.height / v.height);
  const dx = (t.left + t.width/2) - (v.left + v.width/2);
  const dy = (t.top + t.height/2) - (v.top + v.height/2);
  const a = f.animate(
    [{ transform: 'none', opacity: 1, borderRadius: '0px' },
     { transform: `translate(${dx}px,${dy}px) scale(${k})`, opacity: 0, borderRadius: '40px' }],
    { duration: 480, easing: SNAP, fill: 'forwards' });
  a.onfinish = () => { f.hidden = true; f.style.backgroundImage = ''; };
}

async function capture() {
  if (!stream || busy) return;
  busy = true; $('shutter').disabled = true;
  const sh = $('shutter');
  sh.classList.remove('fire'); void sh.offsetWidth; sh.classList.add('fire');
  sh.addEventListener('animationend', () => sh.classList.remove('fire'), { once: true });
  $('flash').classList.remove('go'); void $('flash').offsetWidth; $('flash').classList.add('go');
  navigator.vibrate?.(14);

  try {
    const v = $('video');
    const mirror = facing === 'user';

    /* ONE frame, copied straight off the live video. drawImage is a GPU blit:
       it costs well under a frame. No burst, no takePhoto() — both forced the
       phone into a refocus/re-expose cycle that cost seconds. */
    const cv = toCanvas(v, v.videoWidth, v.videoHeight, mirror);
    const ts = Date.now();                       // stamped at the moment of capture

    /* the camera is usable again right here — everything below is background */
    busy = false; $('shutter').disabled = false;

    /* instant micro-preview — the thumbnail fills before the encode finishes */
    const micro = document.createElement('canvas');
    micro.width = 60; micro.height = Math.round(60 * cv.height / cv.width);
    micro.getContext('2d').drawImage(cv, 0, 0, micro.width, micro.height);
    const preview = micro.toDataURL('image/jpeg', 0.6);
    fly(preview);
    const t = $('toGallery');
    setTimeout(() => {
      t.style.backgroundImage = `url(${preview})`;
      t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');
    }, 420);

    ring('saving');
    const res = await process(await createImageBitmap(cv));
    const blob = res?.blob || await new Promise(r => cv.toBlob(r, 'image/webp', 0.9));
    const rec = { day: dayKey(ts), ts, blob, thumb: res?.thumb || null,
                  lat: pos?.lat ?? null, lon: pos?.lon ?? null, acc: pos?.acc ?? null,
                  place: '', w: res?.w || cv.width, h: res?.h || cv.height };

    /* coordinates are already recorded; the human-readable place name is a
       nicety from a third-party server, so it never delays the upload */
    if (rec.lat != null) {
      rec.place = await Promise.race([
        placeName(rec.lat, rec.lon),
        new Promise(r => setTimeout(() => r(''), 1200))
      ]);
    }
    await send(rec);
  } finally { busy = false; $('shutter').disabled = false; }
}

async function send(rec) {
  if (!cloud.getToken()) { await cloud.queue(rec); ring('failed'); return; }
  ring('uploading', 0.02);
  try {
    const row = await cloud.upload(rec, p => ring('uploading', Math.max(0.02, p)));
    if (rec.qid) await cloud.unqueue(rec.qid);
    const list = [row, ...cloud.cachedList()];
    localStorage.setItem('snapz_index', JSON.stringify(list));
    ring('done');                        // the server said yes — now you may relax
  } catch (e) {
    rec.tries = 1; rec.lastError = String(e.message || e);
    await cloud.queue(rec);
    ring('failed');
  }
}

$('pick').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const ts = Date.now();
  await send({ day: dayKey(ts), ts, blob: f, thumb: null,
               lat: pos?.lat ?? null, lon: pos?.lon ?? null, acc: pos?.acc ?? null, place: '' });
  e.target.value = '';
};

/* ---------- the thumbnail: tap for the gallery, hold for settings ---------- */
function paintThumb() {
  const s = cloud.cachedList()[0];
  if (s && !wrap().classList.contains('busy'))
    $('toGallery').style.backgroundImage = `url(${s.thumb_url || s.url})`;
}

let press = null, held = false;
$('toGallery').addEventListener('pointerdown', () => {
  held = false;
  press = setTimeout(() => { press = null; held = true; navigator.vibrate?.(14); openSheet(); }, 700);
});
['pointerup','pointerleave','pointercancel'].forEach(ev =>
  $('toGallery').addEventListener(ev, () => { clearTimeout(press); press = null; }));
$('toGallery').onclick = e => {
  if (held) { e.preventDefault(); held = false; return; }
  location.href = '/gallery';
};

/* ---------- settings: a real sheet, no typed commands ---------- */
const note = (msg, bad = false) => {
  const el = $('sMsg');
  el.textContent = msg; el.hidden = !msg;
  el.style.color = bad ? 'var(--bad)' : 'var(--dim)';
};

async function openSheet() {
  if (!cloud.getToken()) { localStorage.removeItem('snapz_nocloud'); return location.href = '/lock'; }
  const w = win();
  $('sFrom').value = w.from; $('sTo').value = w.to; $('sLift').checked = !!w.lift;
  note('');
  $('aUrl').value = cloud.apiBase();
  $('passForm').hidden = true; $('apiForm').hidden = true;
  $('sheetWrap').hidden = false;
  try {                                   // the server is the source of truth
    const s = await cloud.getWindow();
    $('sFrom').value = s.from; $('sTo').value = s.to; $('sLift').checked = !!s.lift;
  } catch { note('Offline — showing the last known window.', true); }
}
function closeSheet() {
  const sheet = $('sheet');
  if (still.matches) return $('sheetWrap').hidden = true;
  sheet.animate([{ transform: 'none' }, { transform: 'translateY(100%)' }],
    { duration: 260, easing: 'cubic-bezier(.4,0,1,1)' })
    .finished.then(() => { $('sheetWrap').hidden = true; }).catch(() => { $('sheetWrap').hidden = true; });
}
$('sClose').onclick = closeSheet;
$('sheetBg').onclick = closeSheet;

async function saveWindow() {
  const from = $('sFrom').value, to = $('sTo').value;
  if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) return;
  try {
    await cloud.setWindow({ from, to, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    note(`Photos open ${windowLabel()}, every day.`);
  } catch (e) { note('Could not save: ' + e.message, true); }
}
$('sFrom').onchange = saveWindow;
$('sTo').onchange = saveWindow;

$('sLift').onchange = async e => {
  e.target.disabled = true;
  try { await cloud.setWindow({ lift: e.target.checked });
        note(e.target.checked ? 'Lock lifted — remember to put it back.' : 'Lock restored.'); }
  catch { e.target.checked = !e.target.checked; note('Could not reach the server.', true); }
  finally { e.target.disabled = false; }
};

const toggle = (btn, form) => $(btn).onclick = () => {
  const f = $(form);
  f.hidden = !f.hidden;
  if (!f.hidden) f.querySelector('input').focus();
};
toggle('sPass', 'passForm');
toggle('sApi', 'apiForm');

$('pGo').onclick = async () => {
  const cu = $('pCur').value.trim(), nx = $('pNew').value.trim();
  if (nx.length < 4) return note('New passcode must be at least 4 characters.', true);
  $('pGo').disabled = true;
  try {
    await cloud.changePasscode(cu, nx);
    $('pCur').value = $('pNew').value = '';
    $('passForm').hidden = true;
    note('Passcode changed.');
  } catch (e) { note(e.message, true); }
  finally { $('pGo').disabled = false; }
};
$('aGo').onclick = () => {
  const u = $('aUrl').value.trim();
  if (!u) return;
  cloud.setApi(u); $('apiForm').hidden = true;
  note('Endpoint set to ' + cloud.apiBase());
};
$('sOut').onclick = () => {
  if (!confirm('Sign out of this device?')) return;
  cloud.logout(); localStorage.removeItem('snapz_index'); location.href = '/lock';
};

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('sheetWrap').hidden) closeSheet();
});

/* ================= START ================= */
registerSW();
addEventListener('online', () => cloud.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !stream) startCam();
});
addEventListener('pagehide', () => stream?.getTracks().forEach(t => t.stop()));

if (!cloud.getToken() && !localStorage.getItem('snapz_nocloud')) location.replace('/lock');
startCam();
paintThumb();
cloud.flush();
cloud.getWindow().catch(() => {});
cloud.list({ limit: 1 }).then(d => { cloud.cacheList(d.snaps); paintThumb(); }).catch(() => {});
