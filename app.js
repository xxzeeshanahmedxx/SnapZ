/* SnapZ — a pure camera.
   Tap the shutter, it's saved. Time and place are recorded silently.
   Every shot goes through a quality pipeline (see enhance.js). */

import { enhance, averageFrames } from './enhance.js';
import * as cloud from './sync.js';

const $ = id => document.getElementById(id);
const DB = 'snapz', STORE = 'snaps';
const inFrame = window.self !== window.top;
const BURST = 3;                 // frames averaged when we can't get a real still

/* ---- background image processor ---- */
let worker = null, jobId = 0;
const jobs = new Map();
try {
  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = e => {
    const j = jobs.get(e.data.id);
    if (!j) return;
    jobs.delete(e.data.id);
    j(e.data.error ? null : e.data);
  };
} catch { worker = null; }

const enhanceInWorker = bitmap => new Promise(res => {
  if (!worker) return res(null);
  const id = ++jobId;
  jobs.set(id, res);
  worker.postMessage({ id, bitmap }, [bitmap]);
  setTimeout(() => { if (jobs.has(id)) { jobs.delete(id); res(null); } }, 20000);
});

/* ---------------- storage ---------------- */
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => { const d = r.result;
    if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' }); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => { const db = await dbp;
  return new Promise((res, rej) => { const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); }); };
const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = v => tx('readwrite', s => s.put(v));
const dbDel = id => tx('readwrite', s => s.delete(id));

/* ---------------- helpers ---------------- */
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { weekday:'long', day:'numeric', month:'long', year:'numeric' });
const fmtShort = ts => new Date(ts).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
const dayKey = ts => { const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

let snaps = [], urls = new Map(), stream = null, track = null, imgCap = null;
let facing = 'user', busy = false;
const urlFor = s => { if (!urls.has(s.id)) urls.set(s.id, URL.createObjectURL(s.blob)); return urls.get(s.id); };

/* ---------------- silent location ---------------- */
let lastPos = null;
if (navigator.geolocation) navigator.geolocation.watchPosition(
  p => { lastPos = { lat:+p.coords.latitude.toFixed(6), lon:+p.coords.longitude.toFixed(6), acc:Math.round(p.coords.accuracy) }; },
  () => {}, { enableHighAccuracy:true, maximumAge:120000, timeout:20000 });

async function placeName(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${lat}&lon=${lon}`);
    const a = (await r.json()).address || {};
    return [a.suburb || a.neighbourhood || a.road, a.city || a.town || a.village || a.county, a.country].filter(Boolean).join(', ');
  } catch { return ''; }
}

/* ================= CAMERA ================= */
function showFallback(msg, retry = true) {
  $('fallback').hidden = false; $('fbMsg').textContent = msg;
  $('fbRetry').hidden = !retry; $('fbTab').hidden = !inFrame;
  if (inFrame) $('fbTab').href = location.href;
  $('shutter').disabled = true;
}

async function startCam() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; track = null; imgCap = null;
  if (!window.isSecureContext) return showFallback('Camera needs HTTPS or localhost.', false);
  if (!navigator.mediaDevices?.getUserMedia)
    return showFallback(inFrame ? 'Camera is blocked inside this preview frame.' : 'Camera not supported here.', false);
  try {
    /* ask for the biggest sensor output the device will give us */
    /* Ask for resolution on ONE axis only. Constraining width AND height
       together lets the browser letterbox or squash the sensor into a shape
       it never natively produces — that's what stretches faces. */
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 3840 } },
      audio: false
    });
    track = stream.getVideoTracks()[0];

    /* raise resolution while PINNING the camera's own aspect ratio */
    try {
      const c = track.getCapabilities?.() || {};
      const s = track.getSettings?.() || {};
      const nativeAR = (s.width && s.height) ? s.width / s.height : null;
      const want = {};
      if (c.width?.max && c.width.max > (s.width || 0)) {
        want.width = c.width.max;
        if (nativeAR) want.aspectRatio = nativeAR;   // keep the shape honest
      }
      const adv = [];
      if (c.focusMode?.includes('continuous'))        adv.push({ focusMode: 'continuous' });
      if (c.exposureMode?.includes('continuous'))     adv.push({ exposureMode: 'continuous' });
      if (c.whiteBalanceMode?.includes('continuous')) adv.push({ whiteBalanceMode: 'continuous' });
      if (adv.length) want.advanced = adv;
      if (Object.keys(want).length) await track.applyConstraints(want);

      /* verify: if the result is a shape the sensor doesn't make, back off */
      const after = track.getSettings?.() || {};
      if (nativeAR && after.width && after.height) {
        const gotAR = after.width / after.height;
        if (Math.abs(gotAR - nativeAR) / nativeAR > 0.02)
          await track.applyConstraints({ aspectRatio: nativeAR });
      }
    } catch {}

    /* full-resolution stills, when the browser supports it */
    if (window.ImageCapture) { try { imgCap = new ImageCapture(track); } catch {} }

    const v = $('video');
    v.srcObject = stream; await v.play().catch(() => {});
    v.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';
    $('fallback').hidden = true; $('shutter').disabled = false;
  } catch (e) {
    showFallback({
      NotAllowedError: inFrame ? 'Camera blocked in this preview frame — open SnapZ in a real tab.'
                               : 'Camera permission denied. Allow it in your browser settings.',
      NotFoundError: 'No camera found on this device.',
      NotReadableError: 'Camera is in use by another app.'
    }[e.name] || ('Camera error: ' + e.message));
  }
}
$('fbRetry').onclick = startCam;
$('flip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCam(); };
$('shutter').onclick = () => capture();

/* ---------------- capture ---------------- */
async function capture() {
  if (!stream || busy) return;
  busy = true;
  $('shutter').disabled = true;
  $('flash').classList.remove('go'); void $('flash').offsetWidth; $('flash').classList.add('go');
  if (navigator.vibrate) navigator.vibrate(18);

  try {
    const mirror = facing === 'user';
    let cv;

    /* A. real still from the camera's own pipeline — full megapixels */
    if (imgCap) {
      try {
        /* Only request width. Pairing imageWidth.max with imageHeight.max
           asks for a frame shape the sensor may not have, and the camera
           stretches to fill it. */
        const caps = await imgCap.getPhotoCapabilities().catch(() => null);
        const st = track.getSettings?.() || {};
        const previewAR = (st.width && st.height) ? st.width / st.height : null;
        const opts = {};
        if (caps?.imageWidth?.max) opts.imageWidth = caps.imageWidth.max;
        const shot = await imgCap.takePhoto(opts);
        const bmp = await createImageBitmap(shot);

        /* sanity check: a still whose shape disagrees with the live preview
           means the driver distorted it — fall back to the honest frames */
        const shotAR = bmp.width / bmp.height;
        if (previewAR && Math.abs(shotAR - previewAR) / previewAR > 0.06) {
          bmp.close?.(); cv = null;
        } else {
          cv = toCanvas(bmp, bmp.width, bmp.height, mirror);
          bmp.close?.();
        }
      } catch { cv = null; }
    }

    /* B. fallback: burst-average video frames to kill sensor noise */
    if (!cv) cv = await burstCapture(mirror);

    /* Save the photo FIRST so the shutter feels instant, then enhance in the
       background and swap the better version in when it's ready. */
    const raw = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.95));
    const rec = await save(raw, Date.now());

    busy = false; $('shutter').disabled = false;   // camera is usable again now

    const bmp = await createImageBitmap(cv);
    const res = worker ? await enhanceInWorker(bmp) : await enhanceOnMain(cv);
    if (res?.blob) {
      rec.blob = res.blob;
      rec.type = res.blob.type || rec.type;
      rec.w = res.w ?? rec.w; rec.h = res.h ?? rec.h;
      rec.bytes = res.blob.size;
      await dbPut(rec);
      urls.delete(rec.id);
      await load();
    }
    syncRecord(rec);
  } finally {
    busy = false; $('shutter').disabled = false;
  }
}

/* only used where module workers aren't available */
async function enhanceOnMain(cv) {
  const g = cv.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, cv.width, cv.height);
  enhance(img, cv.width, cv.height);
  g.putImageData(img, 0, 0);
  const tryType = (type, q) => new Promise(r => cv.toBlob(b => r(b && b.type === type ? b : null), type, q));
  const blob = await tryType('image/webp', 0.90) || await tryType('image/jpeg', 0.95);
  return { blob, w: cv.width, h: cv.height };
}

function toCanvas(src, w, h, mirror) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (mirror) { g.translate(w, 0); g.scale(-1, 1); }
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return cv;
}

async function burstCapture(mirror) {
  const v = $('video'), w = v.videoWidth, h = v.videoHeight;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tg = tmp.getContext('2d', { willReadFrequently: true });
  const frames = [];
  for (let i = 0; i < BURST; i++) {
    tg.drawImage(v, 0, 0, w, h);
    frames.push(tg.getImageData(0, 0, w, h));
    if (i < BURST - 1) await new Promise(r => setTimeout(r, 55));
  }
  const avg = averageFrames(frames, w, h);
  const flat = document.createElement('canvas');
  flat.width = w; flat.height = h;
  flat.getContext('2d').putImageData(avg, 0, 0);
  return toCanvas(flat, w, h, mirror);
}

$('pick').onchange = async e => { const f = e.target.files[0]; if (f) await save(f, Date.now()); e.target.value = ''; };

async function save(blob, ts) {
  /* One image per day: a new shot today replaces today's existing one,
     matching the D1 schema where `day` is the primary key. */
  const today = dayKey(ts);
  const existing = snaps.find(s => s.day === today);
  if (existing) { await dbDel(existing.id); urls.delete(existing.id); }

  const rec = { id:'s'+ts+Math.random().toString(36).slice(2,6), ts, day:today,
    lat:lastPos?.lat ?? null, lon:lastPos?.lon ?? null, acc:lastPos?.acc ?? null,
    place:'', synced:false, blob, type: blob.type || 'image/jpeg', bytes: blob.size };
  await dbPut(rec);
  await load();
  /* reverse-geocode without making the shutter wait on the network */
  if (rec.lat != null) placeName(rec.lat, rec.lon).then(async n => {
    if (n) { rec.place = n; await dbPut(rec); syncRecord(rec); }
  });
  return rec;
}

/* ================= CLOUD ================= */
async function syncRecord(rec) {
  if (!cloud.getToken()) return;                 // not configured — stay local-only
  try {
    await cloud.upload(rec);
    rec.synced = true; await dbPut(rec); await load();
  } catch (e) {
    cloud.enqueue(rec.day);                      // retried on reconnect
  }
}
const recordForDay = async day => (await dbAll()).find(s => s.day === day);

/* Pull the cloud archive onto this device (new phone, or after clearing data). */
async function restore() {
  if (!cloud.getToken()) { alert('Set the API token first (long-press the gallery button).'); return; }
  const hdr = $('gcount'); const old = hdr.textContent;
  try {
    const res = await cloud.pull({
      hasDay: recordForDay,
      putDay: async (r, existing) => {
        if (existing) { await dbDel(existing.id); urls.delete(existing.id); }
        await dbPut({ id: 's' + r.ts + Math.random().toString(36).slice(2, 6), day: r.day, ...r });
      },
      onProgress: (i, n) => { hdr.textContent = `restoring ${i}/${n}…`; }
    });
    await load();
    hdr.textContent = `restored ${res.added + res.updated}`;
    setTimeout(load, 2500);
  } catch (e) {
    hdr.textContent = 'restore failed';
    setTimeout(() => { hdr.textContent = old; }, 2500);
  }
}
const flush = () => cloud.flush(recordForDay, async day => {
  const r = await recordForDay(day);
  if (r) { r.synced = true; await dbPut(r); await load(); }
});
window.addEventListener('snapz:flush', flush);

/* ---- login screen ---- */
async function showLogin(lockedOnly = false) {
  let first = false, m = null;
  try { m = await cloud.methods(); first = !m.passcode; } catch {}

  $('lockSkip').hidden = lockedOnly;
  $('lockTitle').textContent = first ? 'Choose a passcode' : 'Enter passcode';
  $('lockSub').textContent   = first
    ? 'You only set this once. It unlocks your backup on any device.'
    : 'Unlock cloud backup on this device';
  if (lockedOnly) { $('lockTitle').textContent = 'SnapZ is locked'; $('lockSub').textContent = 'Unlock to see your photos'; }
  $('lockPass').setAttribute('autocomplete', first ? 'new-password' : 'current-password');
  $('lockErr').hidden = true;
  $('lockPass').value = '';
  $('login').hidden = false;
  setTimeout(() => $('lockPass').focus(), 120);
}
async function doLogin() {
  const pass = $('lockPass').value.trim();
  if (pass.length < 4) { $('lockErr').textContent = 'At least 4 characters'; $('lockErr').hidden = false; return; }
  $('lockGo').disabled = true; $('lockGo').textContent = 'Checking…';
  try {
    const res = await cloud.login(pass);
    $('login').hidden = true;
    locked = false;
    await flush();
    if (!res.created) restore();          // existing account → pull the archive
  } catch (e) {
    $('lockErr').textContent = String(e.message || e);
    $('lockErr').hidden = false;
  } finally {
    $('lockGo').disabled = false; $('lockGo').textContent = 'Continue';
  }
}


$('lockGo').onclick = doLogin;
$('lockPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('lockSkip').onclick = () => { $('login').hidden = true; localStorage.setItem('snapz_nocloud', '1'); };

/* Long-press the gallery button: sign in / out, or restore. */
let pressTimer = null;
$('toGallery').addEventListener('pointerdown', () => {
  pressTimer = setTimeout(async () => {
    pressTimer = null;
    if (!cloud.getToken()) { localStorage.removeItem('snapz_nocloud'); return showLogin(); }
    const choice = prompt('Type: days · restore · passcode · signout · api', '');
    if (choice === 'days') {
      const v = prompt('Which days can you view photos? e.g. sun,fri',
                       OPEN_DAYS.map(d => DAY_NAMES[d].slice(0,3).toLowerCase()).join(','));
      if (!v) return;
      const map = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
      const days = [...new Set(v.toLowerCase().split(/[,\s]+/)
        .map(x => map[x.slice(0,3)]).filter(x => x !== undefined))].sort();
      if (!days.length) { alert('No valid days.'); return; }
      localStorage.setItem('snapz_days', JSON.stringify(days));
      alert('Viewing days: ' + days.map(d => DAY_NAMES[d]).join(', ') + '. Reopen the app to apply.');
      return;
    }
    if (choice === 'restore') restore();
    else if (choice === 'signout') { cloud.logout(); showLogin(); }
    else if (choice === 'api') { const u = prompt('API URL', cloud.apiBase()); if (u) cloud.setApi(u); }
    else if (choice === 'passcode') {
      const cur = prompt('Current passcode'); const nxt = prompt('New passcode');
      if (cur && nxt) cloud.changePasscode(cur, nxt).then(() => alert('Passcode changed'))
        .catch(e => alert(e.message));
    }
  }, 700);
});
['pointerup','pointerleave','pointercancel'].forEach(ev =>
  $('toGallery').addEventListener(ev, () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }));

/* ================= GALLERY ================= */
async function load() {
  snaps = (await dbAll()).sort((a, b) => b.ts - a.ts);
  const bytes = snaps.reduce((n, s) => n + (s.bytes || s.blob?.size || 0), 0);
  const mb = bytes / 1048576;
  $('gcount').textContent = snaps.length
    ? `${snaps.length} ${snaps.length === 1 ? 'snap' : 'snaps'} · ${mb < 1024 ? mb.toFixed(mb < 10 ? 1 : 0) + ' MB' : (mb / 1024).toFixed(1) + ' GB'}` +
      (cloud.pending() ? ` · ${cloud.pending()} to upload` : '') +
      (navigator.onLine ? '' : ' · offline')
    : (navigator.onLine ? '' : 'offline');
  const t = $('toGallery');
  if (snaps[0] && isOpenToday()) {
    t.classList.remove('shut');
    t.style.backgroundImage = `url(${urlFor(snaps[0])})`;
    t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');
  } else {
    t.style.backgroundImage = '';
    t.classList.toggle('shut', !isOpenToday());
  }
  $('empty').hidden = snaps.length > 0;
  $('playBtn').hidden = snaps.length < 2;
  $('grid').innerHTML = '';
  if (!isOpenToday()) return;
  snaps.forEach(s => { const i = new Image();
    i.src = urlFor(s); i.loading = 'lazy'; i.onclick = () => openViewer(s); $('grid').appendChild(i); });
}
const show = id => document.querySelectorAll('.screen').forEach(s =>
  (s.id === 'viewer' || s.id === 'lapse') ? 0 : s.classList.toggle('on', s.id === id));
$('toGallery').onclick = () => { if (!isOpenToday()) return showGate(); show('gal'); };
$('toCam').onclick = () => show('cam');

/* ================= VIEWER ================= */
let cur = null;
function openViewer(s) {
  if (!isOpenToday()) return showGate();
  cur = s; const u = urlFor(s);
  $('vImg').src = u;
  $('vDate').textContent = fmtDate(s.ts);
  $('vTime').textContent = fmtTime(s.ts);
  $('vPlace').textContent = s.place || (s.lat != null ? `${s.lat}, ${s.lon}` : '');
  $('vPlace').hidden = !s.place && s.lat == null;
  $('vMap').hidden = s.lat == null;
  if (s.lat != null) $('vMap').href = `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`;
  $('vOpen').href = u;
  const ext = (s.type || 'image/jpeg').split('/')[1].replace('jpeg', 'jpg');
  $('vDl').href = u; $('vDl').download = `snapz-${s.day}-${new Date(s.ts).toTimeString().slice(0,5).replace(':','')}.${ext}`;
  $('viewer').hidden = false;
}
$('vClose').onclick = () => { $('viewer').hidden = true; cur = null; };
$('vDel').onclick = async () => {
  if (!cur || !confirm('Delete this snap?')) return;
  const day = cur.day;
  await dbDel(cur.id); urls.delete(cur.id); $('viewer').hidden = true; cur = null; await load();
  if (cloud.getToken()) cloud.remoteDelete(day).catch(() => {});
};

/* ================= TIME-LAPSE ================= */
let lapseTimer = null, lapseImgs = [], recorder = null, LW = 1080, LH = 1440;
$('playBtn').onclick = async () => {
  if (!isOpenToday()) return showGate();
  const ordered = [...snaps].reverse();
  lapseImgs = await Promise.all(ordered.map(s => new Promise(r => {
    const i = new Image(); i.onload = () => r({ img: i, ts: s.ts }); i.src = urlFor(s); })));
  if (lapseImgs[0]) { LW = 1080; LH = Math.round(1080 * lapseImgs[0].img.height / lapseImgs[0].img.width); }
  $('lapse').hidden = false;
  playLapse();
};
function paint(g, f, w, h) {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  const s = Math.min(w / f.img.width, h / f.img.height);
  const dw = f.img.width * s, dh = f.img.height * s;
  g.drawImage(f.img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
function playLapse() {
  const cv = $('lapseCv'); cv.width = LW; cv.height = LH;
  const g = cv.getContext('2d');
  let i = 0;
  clearInterval(lapseTimer);
  const tick = () => {
    const f = lapseImgs[i % lapseImgs.length];
    paint(g, f, LW, LH);
    $('lapseDate').textContent = fmtShort(f.ts);
    i++;
  };
  tick();
  lapseTimer = setInterval(tick, 1000 / +$('lSpeed').value);
}
$('lSpeed').oninput = () => { if (!$('lapse').hidden) playLapse(); };
$('lClose').onclick = () => { clearInterval(lapseTimer); lapseTimer = null; $('lapse').hidden = true; };

$('lSave').onclick = async () => {
  if (recorder) return;
  const fps = +$('lSpeed').value;
  const cv = document.createElement('canvas'); cv.width = LW; cv.height = LH;
  const g = cv.getContext('2d');
  const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const chunks = [];
  recorder = new MediaRecorder(cv.captureStream(fps), { mimeType: mime, videoBitsPerSecond: 8e6 });
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type: mime }));
    a.download = `snapz-timelapse.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    recorder = null; $('lSave').textContent = 'Save video';
  };
  recorder.start();
  $('lSave').textContent = 'Rendering…';
  for (const f of lapseImgs) { paint(g, f, LW, LH); await new Promise(r => setTimeout(r, 1000 / fps)); }
  await new Promise(r => setTimeout(r, 250));
  recorder.stop();
};

/* ================= EXPORT ================= */
$('menu').onclick = async () => {
  if (!snaps.length) return;
  const rows = await Promise.all(snaps.map(async s => ({
    date: fmtDate(s.ts), time: fmtTime(s.ts), iso: new Date(s.ts).toISOString(),
    lat: s.lat, lon: s.lon, accuracy_m: s.acc, place: s.place,
    map: s.lat != null ? `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}` : null,
    image: await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(s.blob); })
  })));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app:'SnapZ', exported:new Date().toISOString(), snaps:rows }, null, 2)], { type:'application/json' }));
  a.download = `snapz-${dayKey(Date.now())}.json`; a.click();
};

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('lapse').hidden) $('lClose').onclick();
  else if (!$('viewer').hidden) $('vClose').onclick();
  else show('cam');
});

/* ---------------- day gate ----------------
   Your photos are only viewable on the days you chose. The camera always
   works — this restricts looking back, not recording. */
const OPEN_DAYS = JSON.parse(localStorage.getItem('snapz_days') || '[0,5]');  // Sun=0, Fri=5
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const isOpenToday = () => OPEN_DAYS.includes(new Date().getDay());

function nextOpen() {
  const now = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    d.setHours(0, 0, 0, 0);
    if (OPEN_DAYS.includes(d.getDay())) return d;
  }
  return null;
}

let gateTimer = null;
function showGate() {
  const names = OPEN_DAYS.map(d => DAY_NAMES[d]);
  $('gateDay').textContent = DAY_NAMES[new Date().getDay()].slice(0, 3);
  $('gateMsg').textContent = 'Your photos open on ' + names.join(' and ') + '.';
  $('gate').hidden = false;
  clearInterval(gateTimer);
  const tick = () => {
    const n = nextOpen();
    if (!n) return;
    const s = Math.max(0, Math.floor((n - Date.now()) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), d = Math.floor(h / 24);
    $('gateCount').textContent = d > 0
      ? 'Opens in ' + d + 'd ' + (h % 24) + 'h'
      : 'Opens in ' + h + 'h ' + m + 'm ' + (s % 60) + 's';
    if (s === 0) { clearInterval(gateTimer); $('gate').hidden = true; load(); }
  };
  tick();
  gateTimer = setInterval(tick, 1000);
}
$('gateClose').onclick = () => { clearInterval(gateTimer); $('gate').hidden = true; show('cam'); };

/* ---------------- offline ---------------- */
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
addEventListener('online',  () => { load(); flush(); });
addEventListener('offline', () => load());

/* ---------------- go ---------------- */
/* Browsers may evict IndexedDB under storage pressure. This is a decades-long
   archive, so ask for persistent storage up front. */
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

load().then(async () => {
  if (!cloud.getToken() && !localStorage.getItem('snapz_nocloud')) showLogin();
  else flush();
});
startCam();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !stream) startCam();
});
window.addEventListener('pagehide', () => stream && stream.getTracks().forEach(t => t.stop()));
