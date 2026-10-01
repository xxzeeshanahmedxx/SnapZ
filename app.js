/* SnapZ — a pure camera.
   Capture goes straight to the cloud; the gallery renders only what D1 and R2
   return. Nothing is read from local storage except the offline outbox. */

import * as cloud from './api.js';

const $ = id => document.getElementById(id);
const inFrame = window.self !== window.top;
const BURST = 3;

/* ---------- day gate: photos are viewable only on chosen days ---------- */
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const openDays = () => { try { return JSON.parse(localStorage.getItem('snapz_days')) || [0,5]; }
                         catch { return [0,5]; } };
const isOpen = () => openDays().includes(new Date().getDay());
function nextOpen() {
  const n = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(n); d.setDate(n.getDate() + i); d.setHours(0,0,0,0);
    if (openDays().includes(d.getDay())) return d;
  }
}

/* ---------- helpers ---------- */
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { weekday:'long', day:'numeric', month:'long', year:'numeric' });
const fmtShort = ts => new Date(ts).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
const dayKey = ts => { const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

let snaps = [], stream = null, track = null, imgCap = null, facing = 'user', busy = false;

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
  $('shutter').disabled = true;
}

async function startCam() {
  stream?.getTracks().forEach(t => t.stop());
  stream = track = imgCap = null;
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
    if (window.ImageCapture) { try { imgCap = new ImageCapture(track); } catch {} }

    const v = $('video');
    v.srcObject = stream; await v.play().catch(() => {});
    v.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';
    $('fallback').hidden = true; $('shutter').disabled = false;
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
$('flip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCam(); };
$('shutter').onclick = () => capture();

/* ---------- capture -> process -> upload ---------- */
function toCanvas(src, w, h, mirror) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (mirror) { g.translate(w, 0); g.scale(-1, 1); }
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return cv;
}

async function burst(mirror) {
  const v = $('video'), w = v.videoWidth, h = v.videoHeight;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const g = tmp.getContext('2d', { willReadFrequently: true });
  const frames = [];
  for (let i = 0; i < BURST; i++) {
    g.drawImage(v, 0, 0, w, h);
    frames.push(g.getImageData(0, 0, w, h));
    if (i < BURST - 1) await new Promise(r => setTimeout(r, 55));
  }
  const { averageFrames } = await import('./enhance.js');
  const flat = document.createElement('canvas');
  flat.width = w; flat.height = h;
  flat.getContext('2d').putImageData(averageFrames(frames, w, h), 0, 0);
  return toCanvas(flat, w, h, mirror);
}

async function capture() {
  if (!stream || busy) return;
  busy = true; $('shutter').disabled = true;
  $('flash').classList.remove('go'); void $('flash').offsetWidth; $('flash').classList.add('go');
  navigator.vibrate?.(18);

  try {
    const mirror = facing === 'user';
    let cv = null;
    if (imgCap) {
      try {
        const caps = await imgCap.getPhotoCapabilities().catch(() => null);
        const st = track.getSettings?.() || {};
        const ar = st.width && st.height ? st.width / st.height : null;
        const shot = await imgCap.takePhoto(caps?.imageWidth?.max ? { imageWidth: caps.imageWidth.max } : {});
        const bmp = await createImageBitmap(shot);
        if (ar && Math.abs(bmp.width / bmp.height - ar) / ar > 0.06) { bmp.close?.(); }
        else { cv = toCanvas(bmp, bmp.width, bmp.height, mirror); bmp.close?.(); }
      } catch {}
    }
    if (!cv) cv = await burst(mirror);

    const ts = Date.now(), day = dayKey(ts);
    const res = await process(await createImageBitmap(cv));
    const blob = res?.blob || await new Promise(r => cv.toBlob(r, 'image/webp', 0.9));
    const rec = { day, ts, blob, thumb: res?.thumb || null,
                  lat: pos?.lat ?? null, lon: pos?.lon ?? null, acc: pos?.acc ?? null,
                  place: '', w: res?.w || cv.width, h: res?.h || cv.height };

    busy = false; $('shutter').disabled = false;       // camera is free again

    if (rec.lat != null) rec.place = await placeName(rec.lat, rec.lon);
    await send(rec);
  } finally { busy = false; $('shutter').disabled = false; }
}

async function send(rec) {
  if (!cloud.getToken()) { await cloud.queue(rec); return note('saved locally — sign in to upload'); }
  try {
    const row = await cloud.upload(rec);
    await cloud.unqueue(rec.day);
    snaps = [row, ...snaps.filter(s => s.day !== row.day)];
    localStorage.setItem('snapz_index', JSON.stringify(snaps));
    paint();
  } catch {
    await cloud.queue(rec);
    note('offline — will upload later');
    paint();
  }
}

$('pick').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const ts = Date.now();
  await send({ day: dayKey(ts), ts, blob: f, thumb: null,
               lat: pos?.lat ?? null, lon: pos?.lon ?? null, acc: pos?.acc ?? null, place: '' });
  e.target.value = '';
};

let noteTimer;
function note(msg) {
  const h = $('gcount'); h.textContent = msg;
  clearTimeout(noteTimer); noteTimer = setTimeout(paintCount, 2600);
}

/* ================= GALLERY (cloud only) ================= */
async function refresh() {
  snaps = cloud.cachedList();            // instant paint from the last index
  paint();
  if (!cloud.getToken() || !navigator.onLine) return;
  try { snaps = await cloud.list(); paint(); } catch (e) {
    if (String(e.message) === 'unauthorized') showLogin();
  }
}

function paintCount() {
  cloud.pending().then(q => {
    const mb = snaps.reduce((n, s) => n + (s.bytes || 0), 0) / 1048576;
    $('gcount').textContent = snaps.length
      ? `${snaps.length} ${snaps.length === 1 ? 'snap' : 'snaps'} · ${mb < 1024 ? mb.toFixed(mb < 10 ? 1 : 0) + ' MB' : (mb/1024).toFixed(1) + ' GB'}`
        + (q.length ? ` · ${q.length} to upload` : '') + (navigator.onLine ? '' : ' · offline')
      : (navigator.onLine ? '' : 'offline');
  });
}

function paint() {
  const t = $('toGallery');
  if (snaps[0] && isOpen()) {
    t.classList.remove('shut');
    t.style.backgroundImage = `url(${snaps[0].thumb_url || snaps[0].url})`;
    t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');
  } else { t.style.backgroundImage = ''; t.classList.toggle('shut', !isOpen()); }

  $('empty').hidden = snaps.length > 0;
  $('playBtn').hidden = snaps.length < 2;
  paintCount();

  const grid = $('grid');
  grid.innerHTML = '';
  if (!isOpen()) return;
  for (const s of snaps) {
    const i = new Image();
    i.src = s.thumb_url || s.url;        // ~20 KB, not the full photo
    i.loading = 'lazy'; i.decoding = 'async';
    i.onclick = () => openViewer(s);
    grid.appendChild(i);
  }
}

const show = id => document.querySelectorAll('.screen').forEach(s =>
  ['viewer','lapse','gate','login'].includes(s.id) ? 0 : s.classList.toggle('on', s.id === id));
$('toGallery').onclick = () => { if (!isOpen()) return gate(); show('gal'); refresh(); };
$('toCam').onclick = () => show('cam');

/* ---------- day gate ---------- */
let gateTimer;
function gate() {
  $('gateDay').textContent = DAYS[new Date().getDay()].slice(0, 3);
  $('gateMsg').textContent = 'Your photos open on ' + openDays().map(d => DAYS[d]).join(' and ') + '.';
  $('gate').hidden = false;
  clearInterval(gateTimer);
  const tick = () => {
    const n = nextOpen(); if (!n) return;
    const s = Math.max(0, Math.floor((n - Date.now()) / 1000));
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), d = Math.floor(h/24);
    $('gateCount').textContent = d > 0 ? `Opens in ${d}d ${h%24}h` : `Opens in ${h}h ${m}m ${s%60}s`;
    if (!s) { clearInterval(gateTimer); $('gate').hidden = true; refresh(); }
  };
  tick(); gateTimer = setInterval(tick, 1000);
}
$('gateClose').onclick = () => { clearInterval(gateTimer); $('gate').hidden = true; show('cam'); };

/* ================= VIEWER ================= */
let cur = null;
function openViewer(s) {
  if (!isOpen()) return gate();
  cur = s;
  $('vImg').src = s.thumb_url || s.url;          // show instantly…
  const full = new Image();
  full.onload = () => { if (cur === s) $('vImg').src = s.url; };
  full.src = s.url;                              // …then swap in full resolution
  $('vDate').textContent = fmtDate(s.ts);
  $('vTime').textContent = fmtTime(s.ts);
  $('vPlace').textContent = s.place || (s.lat != null ? `${s.lat}, ${s.lon}` : '');
  $('vPlace').hidden = !s.place && s.lat == null;
  $('vMap').hidden = s.lat == null;
  if (s.lat != null) $('vMap').href = `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`;
  $('vOpen').href = s.url;
  $('vDl').href = s.url; $('vDl').download = `snapz-${s.day}.webp`;
  $('viewer').hidden = false;
}
$('vClose').onclick = () => { $('viewer').hidden = true; cur = null; };
$('vDel').onclick = async () => {
  if (!cur || !confirm('Delete this snap?')) return;
  const day = cur.day;
  $('viewer').hidden = true; cur = null;
  await cloud.remove(day);
  snaps = snaps.filter(s => s.day !== day);
  localStorage.setItem('snapz_index', JSON.stringify(snaps));
  paint();
};

/* ================= TIME-LAPSE ================= */
let lapseTimer, frames = [], recorder = null, LW = 1080, LH = 1440;
$('playBtn').onclick = async () => {
  if (!isOpen()) return gate();
  const ordered = [...snaps].reverse();
  frames = await Promise.all(ordered.map(s => new Promise(r => {
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => r({ img: i, ts: s.ts }); i.onerror = () => r(null);
    i.src = s.url;
  })));
  frames = frames.filter(Boolean);
  if (!frames.length) return;
  LW = 1080; LH = Math.round(1080 * frames[0].img.height / frames[0].img.width);
  $('lapse').hidden = false; playLapse();
};
const paintFrame = (g, f, w, h) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  const s = Math.min(w / f.img.width, h / f.img.height);
  g.drawImage(f.img, (w - f.img.width*s)/2, (h - f.img.height*s)/2, f.img.width*s, f.img.height*s);
};
function playLapse() {
  const cv = $('lapseCv'); cv.width = LW; cv.height = LH;
  const g = cv.getContext('2d');
  let i = 0;
  clearInterval(lapseTimer);
  const tick = () => { const f = frames[i++ % frames.length];
    paintFrame(g, f, LW, LH); $('lapseDate').textContent = fmtShort(f.ts); };
  tick(); lapseTimer = setInterval(tick, 1000 / +$('lSpeed').value);
}
$('lSpeed').oninput = () => { if (!$('lapse').hidden) playLapse(); };
$('lClose').onclick = () => { clearInterval(lapseTimer); $('lapse').hidden = true; };
$('lSave').onclick = async () => {
  if (recorder) return;
  const fps = +$('lSpeed').value;
  const cv = document.createElement('canvas'); cv.width = LW; cv.height = LH;
  const g = cv.getContext('2d');
  const mime = ['video/mp4;codecs=avc1','video/webm;codecs=vp9','video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const chunks = [];
  recorder = new MediaRecorder(cv.captureStream(fps), { mimeType: mime, videoBitsPerSecond: 8e6 });
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type: mime }));
    a.download = `snapz-timelapse.${mime.includes('mp4') ? 'mp4' : 'webm'}`; a.click();
    recorder = null; $('lSave').textContent = 'Save video';
  };
  recorder.start(); $('lSave').textContent = 'Rendering…';
  for (const f of frames) { paintFrame(g, f, LW, LH); await new Promise(r => setTimeout(r, 1000/fps)); }
  await new Promise(r => setTimeout(r, 250));
  recorder.stop();
};

/* ================= LOGIN / SETTINGS ================= */
async function showLogin() {
  let first = false;
  try { first = !(await cloud.status()).configured; } catch {}
  $('lockTitle').textContent = first ? 'Choose a passcode' : 'Enter passcode';
  $('lockSub').textContent = first ? 'You only set this once. It unlocks your photos on any device.'
                                   : 'Sign in to see your photos';
  $('lockErr').hidden = true; $('lockPass').value = '';
  $('login').hidden = false;
  setTimeout(() => $('lockPass').focus(), 120);
}
async function doLogin() {
  const pass = $('lockPass').value.trim();
  if (pass.length < 4) { $('lockErr').textContent = 'At least 4 characters'; $('lockErr').hidden = false; return; }
  $('lockGo').disabled = true; $('lockGo').textContent = 'Checking…';
  try {
    await cloud.login(pass);
    $('login').hidden = true;
    await cloud.flush();
    await refresh();
  } catch (e) { $('lockErr').textContent = String(e.message || e); $('lockErr').hidden = false; }
  finally { $('lockGo').disabled = false; $('lockGo').textContent = 'Continue'; }
}
$('lockGo').onclick = doLogin;
$('lockPass').addEventListener('keydown', e => e.key === 'Enter' && doLogin());
$('lockSkip').onclick = () => { $('login').hidden = true; localStorage.setItem('snapz_nocloud','1'); };

let press = null;
$('toGallery').addEventListener('pointerdown', () => {
  press = setTimeout(async () => {
    press = null;
    if (!cloud.getToken()) { localStorage.removeItem('snapz_nocloud'); return showLogin(); }
    const c = prompt('Type: days · passcode · signout · api', '');
    if (c === 'days') {
      const map = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
      const v = prompt('Days you can view photos, e.g. sun,fri',
                       openDays().map(d => DAYS[d].slice(0,3).toLowerCase()).join(','));
      if (!v) return;
      const days = [...new Set(v.toLowerCase().split(/[,\s]+/).map(x => map[x.slice(0,3)])
        .filter(x => x !== undefined))].sort();
      if (!days.length) return alert('No valid days.');
      localStorage.setItem('snapz_days', JSON.stringify(days));
      alert('Viewing days: ' + days.map(d => DAYS[d]).join(', '));
      paint();
    } else if (c === 'passcode') {
      const cu = prompt('Current passcode'), nx = prompt('New passcode');
      if (cu && nx) cloud.changePasscode(cu, nx).then(() => alert('Changed')).catch(e => alert(e.message));
    } else if (c === 'signout') { cloud.logout(); snaps = []; paint(); showLogin(); }
    else if (c === 'api') { const u = prompt('API URL', cloud.apiBase()); if (u) cloud.setApi(u); }
  }, 700);
});
['pointerup','pointerleave','pointercancel'].forEach(ev =>
  $('toGallery').addEventListener(ev, () => { clearTimeout(press); press = null; }));

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('lapse').hidden) $('lClose').onclick();
  else if (!$('viewer').hidden) $('vClose').onclick();
  else if (!$('gate').hidden) $('gateClose').onclick();
  else show('cam');
});

/* ================= START ================= */
if ('serviceWorker' in navigator)
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
addEventListener('online', async () => { await cloud.flush(); refresh(); });
addEventListener('offline', paintCount);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !stream) startCam();
});
addEventListener('pagehide', () => stream?.getTracks().forEach(t => t.stop()));

startCam();
refresh();
cloud.flush();
if (!cloud.getToken() && !localStorage.getItem('snapz_nocloud')) showLogin();

/* JSON export of the metadata D1 holds */
$('menu').onclick = () => {
  if (!isOpen()) return gate();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(snaps, null, 2)], { type: 'application/json' }));
  a.download = 'snapz-metadata.json'; a.click();
};
