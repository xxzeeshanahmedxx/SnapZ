/* SnapZ — a pure camera.
   Capture goes straight to the cloud; the gallery renders only what D1 and R2
   return. Nothing is read from local storage except the offline outbox. */

import * as cloud from './api.js';

const $ = id => document.getElementById(id);
const inFrame = window.self !== window.top;
const BURST = 3;

/* ---------- motion ---------- */
const SPRING = 'cubic-bezier(.22,1.2,.36,1)';
const SNAP   = 'cubic-bezier(.2,.9,.3,1)';
const still  = matchMedia('(prefers-reduced-motion: reduce)');
let ready = false;                      // no motion until the camera is up
const animate = (el, frames, opts) => {
  if (!el || still.matches || !ready) return { finished: Promise.resolve() };
  return el.animate(frames, { fill: 'both', ...opts });
};

/* ---------- day gate ---------- */
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const openDays = () => { try { return JSON.parse(localStorage.getItem('snapz_days')) || [0,5]; }
                         catch { return [0,5]; } };
const isOpen = () => openDays().includes(new Date().getDay());
/* A testing override. Deliberately loud in the UI so it cannot be left on by
   accident. */
const TEST = 'snapz_testunlock';
const lifted = () => localStorage.getItem(TEST) === '1';
const locked = () => !isOpen() && !lifted();
function nextOpen() {
  const n = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(n); d.setDate(n.getDate() + i); d.setHours(0,0,0,0);
    if (openDays().includes(d.getDay())) return d;
  }
}
const plural = list => list.length === 1 ? list[0] + 's'
  : list.slice(0, -1).map(d => d + 's').join(', ') + ' and ' + list.at(-1) + 's';

/* ---------- dates ---------- */
const fmtDate  = ts => new Date(ts).toLocaleDateString(undefined, { weekday:'long', day:'numeric', month:'long', year:'numeric' });
const fmtShort = ts => new Date(ts).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
const fmtTime  = ts => new Date(ts).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
const fmtMonth = ts => new Date(ts).toLocaleDateString(undefined, { month:'long', year:'numeric' });
const dayKey   = ts => { const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const mb = b => b >= 1048576 * 1024 ? (b/1073741824).toFixed(1) + ' GB' : (b/1048576).toFixed(1) + ' MB';

let snaps = [], stream = null, track = null, imgCap = null, facing = 'user', busy = false;
const cells = new Map();                 // day -> grid element, for the zoom

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
  if (state === 'saving') {
    $('ring').style.animation = 'spin 1s linear infinite';
  } else { $('ring').style.animation = ''; }
  if (state === 'done') {
    navigator.vibrate?.([0, 12]);
    setTimeout(() => { w.classList.remove('done', 'busy'); }, 1700);
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
  const sx = t.width / v.width, sy = t.height / v.height;
  const dx = (t.left + t.width/2) - (v.left + v.width/2);
  const dy = (t.top + t.height/2) - (v.top + v.height/2);
  const a = f.animate(
    [{ transform: 'none', opacity: 1, borderRadius: '0px' },
     { transform: `translate(${dx}px,${dy}px) scale(${Math.max(sx,sy)})`, opacity: 0, borderRadius: '40px' }],
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
  if (!cloud.getToken()) { await cloud.queue(rec); ring('failed'); return paint(); }
  ring('uploading', 0.02);
  try {
    const row = await cloud.upload(rec, p => ring('uploading', Math.max(0.02, p)));
    await cloud.unqueue(rec.day);
    snaps = [row, ...snaps.filter(s => s.day !== row.day)];
    localStorage.setItem('snapz_index', JSON.stringify(snaps));
    ring('done');                        // the server said yes — now you may relax
    paint();
  } catch (e) {
    rec.tries = 1; rec.lastError = String(e.message || e);
    await cloud.queue(rec);
    ring('failed');
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

/* ================= GALLERY ================= */
async function refresh() {
  snaps = cloud.cachedList();            // instant paint from the last index
  paint();
  if (!cloud.getToken() || !navigator.onLine) return;
  try { snaps = await cloud.list(); paint(); } catch (e) {
    if (String(e.message) === 'unauthorized') showLogin();
  }
}

/* An honest ledger, not a statistic: how much is recorded, and whether the
   record has holes. */
function ledger() {
  const el = $('ledger');
  if (!snaps.length) { el.hidden = true; return; }
  const days = [...snaps].sort((a, b) => a.ts - b.ts);
  let gap = null;
  for (let i = days.length - 1; i > 0; i--) {
    const d = Math.round((new Date(days[i].day) - new Date(days[i-1].day)) / 86400000);
    if (d > 1) { gap = days[i].day; break; }
  }
  const bytes = snaps.reduce((n, s) => n + (s.bytes || 0), 0);
  const unbroken = gap ? `unbroken since ${fmtShort(new Date(gap).getTime())}`
                       : `no missing days since ${fmtShort(days[0].ts)}`;
  el.innerHTML = `<b>${snaps.length} day${snaps.length === 1 ? '' : 's'} recorded</b> · ${unbroken} · ${mb(bytes)}`;
  el.hidden = false;
}

/* Failures are stated, never swallowed. */
async function alertBar() {
  const el = $('alert');
  const q = await cloud.pending();
  if (!q.length) { el.hidden = true; return; }
  const worst = q.reduce((a, b) => (b.tries || 0) > (a.tries || 0) ? b : a);
  const failed = (worst.tries || 0) > 0;
  el.innerHTML = '';
  const txt = document.createElement('span');
  txt.textContent = failed
    ? `${q.length} upload${q.length > 1 ? 's' : ''} failed${worst.tries > 1 ? ` · ${worst.tries} attempts` : ''}${worst.lastError ? ' · ' + worst.lastError : ''}`
    : `${q.length} photo${q.length > 1 ? 's' : ''} waiting to upload`;
  const btn = document.createElement('button');
  btn.textContent = navigator.onLine ? 'Retry' : 'Offline';
  btn.disabled = !navigator.onLine;
  btn.onclick = async () => { btn.textContent = 'Sending…'; await cloud.flush(); await refresh(); };
  el.append(txt, btn);
  el.hidden = false;
}

function paintCount() {
  cloud.pending().then(q => {
    $('gcount').textContent = snaps.length
      ? `${snaps.length} ${snaps.length === 1 ? 'snap' : 'snaps'}`
        + (q.length ? ` · ${q.length} pending` : '') + (navigator.onLine ? '' : ' · offline')
      : (navigator.onLine ? '' : 'offline');
  });
}

const ICON = {
  ok:   '<svg viewBox="0 0 24 24"><path d="M4 12.5l5.5 5.5L20 7"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>',
  none: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/></svg>'
};

let firstPaint = true;
function paint() {
  /* Everything renders as it would on an open day — the wall is the only thing
     standing between you and it. */
  const t = $('toGallery');
  t.classList.remove('shut');
  if (snaps[0] && !wrap().classList.contains('busy'))
    t.style.backgroundImage = `url(${snaps[0].thumb_url || snaps[0].url})`;

  $('playBtn').hidden = snaps.length < 2;
  paintCount(); alertBar(); wall();

  const grid = $('grid');
  grid.innerHTML = '';
  cells.clear();

  ledger();
  $('empty').hidden = snaps.length > 0;

  let month = '', n = 0;
  for (const s of snaps) {
    const m = fmtMonth(s.ts);
    if (m !== month) {
      month = m;
      const h = document.createElement('div');
      h.className = 'month'; h.textContent = m;
      grid.appendChild(h);
    }
    const cell = document.createElement('button');
    cell.className = 'cell';
    const i = new Image();
    i.src = s.thumb_url || s.url;        // ~20 KB, not the full photo
    i.loading = 'lazy'; i.decoding = 'async'; i.alt = '';
    i.onload = () => i.classList.add('in');
    if (i.complete) i.classList.add('in');
    const d = document.createElement('span');
    d.className = 'dnum'; d.textContent = new Date(s.ts).getDate();
    cell.append(i, d);
    cell.onclick = () => openViewer(s, cell);
    if (firstPaint && n < 12 && !still.matches) {
      cell.classList.add('enter');
      cell.style.animationDelay = (n * 22) + 'ms';
    }
    grid.appendChild(cell);
    cells.set(s.day, cell);
    n++;
  }
  firstPaint = false;
}

/* day numbers appear only when you stop scrolling */
let restTimer;
$('gal').addEventListener('scroll', () => {
  $('grid').classList.remove('rest');
  clearTimeout(restTimer);
  restTimer = setTimeout(() => $('grid').classList.add('rest'), 220);
}, { passive: true });

const show = id => document.querySelectorAll('.screen').forEach(s =>
  ['viewer','lapse','gate','login'].includes(s.id) ? 0 : s.classList.toggle('on', s.id === id));
$('toGallery').onclick = () => { show('gal'); $('grid').classList.add('rest'); wall(); refresh(); };
$('toCam').onclick = () => { show('cam'); wall(); };

/* ---------- the wall ----------
   Scoped to the gallery, viewer and time-lapse. Never the camera: taking the
   day's photo is never gated. */
let wallTimer;
const onPhotoScreen = () =>
  $('gal').classList.contains('on') || !$('viewer').hidden || !$('lapse').hidden;

function wallProof() {
  const el = $('wallProof');
  const today = dayKey(Date.now());
  const done = snaps.find(s => s.day === today);
  const put = (k, txt) => { el.className = 'wall-proof ' + k;
    el.innerHTML = ICON[k] + `<span>${txt}</span>`; };
  if (done) put('ok', `Today is saved · ${fmtTime(done.ts)} · confirmed`);
  else {
    put('none', 'No snap today');
    cloud.pending().then(q => {
      const w = q.find(r => r.day === today);
      if (w) put('wait', `Waiting to upload · taken ${fmtTime(w.ts)}`);
    });
  }
}

function wall() {
  const w = $('wall');
  $('testChip').hidden = !lifted();
  $('wallTest').checked = lifted();

  if (!locked() || !onPhotoScreen()) {
    w.hidden = true; clearInterval(wallTimer); return;
  }
  if (w.hidden) {
    w.hidden = false;
    $('wallMsg').textContent = 'You chose ' + plural(openDays().map(d => DAYS[d])) + '.';
    wallProof();
  }
  clearInterval(wallTimer);
  const tick = () => {
    const n = nextOpen(); if (!n) return;
    const s = Math.max(0, Math.floor((n - Date.now()) / 1000));
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), d = Math.floor(h/24);
    $('wallCount').textContent = d > 0 ? `Opens in ${d}d ${h%24}h ${m}m` : `Opens in ${h}h ${m}m ${s%60}s`;
    if (!s) { clearInterval(wallTimer); w.hidden = true; refresh(); }
  };
  tick(); wallTimer = setInterval(tick, 1000);
}

$('wallBack').onclick = () => { clearInterval(wallTimer); $('wall').hidden = true; show('cam'); };
$('wallTest').onchange = e => {
  if (e.target.checked) localStorage.setItem(TEST, '1'); else localStorage.removeItem(TEST);
  navigator.vibrate?.(12);
  wall();
};
$('testChip').onclick = () => { localStorage.removeItem(TEST); wall(); };

/* ================= VIEWER ================= */
let cur = null, fromCell = null;

function fill(s) {
  const fade = $('vFade');
  fade.classList.add('swap');
  setTimeout(() => {
    $('vPlace').textContent = s.place || '';
    $('vDate').textContent  = fmtDate(s.ts);
    $('vTime').textContent  = fmtTime(s.ts)
      + (s.lat != null ? ` · ${s.lat}, ${s.lon}${s.accuracy ? ` ±${Math.round(s.accuracy)}m` : ''}` : '');
    $('vProof').textContent = `Confirmed by the server · ${s.time || ''}${s.bytes ? ' · ' + mb(s.bytes) : ''}`;
    $('vMap').hidden = s.lat == null;
    if (s.lat != null) $('vMap').href = `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`;
    $('vOpen').href = s.url;
    $('vDl').href = s.url; $('vDl').download = `snapz-${s.day}.webp`;
    $('vPos').textContent = `${snaps.indexOf(s) + 1} of ${snaps.length}`;
    fade.classList.remove('swap');
  }, still.matches ? 0 : 200);
}

function load(s) {
  cur = s;
  $('vImg').src = s.thumb_url || s.url;          // show instantly…
  const full = new Image();
  full.onload = () => { if (cur === s) $('vImg').src = s.url; };
  full.src = s.url;                              // …then swap in full resolution
  fill(s);
}

/* Where the photo will land, computed rather than measured — the image may not
   have decoded yet when the zoom has to start. */
function targetRect(s) {
  const vw = innerWidth, vh = innerHeight;
  const w = s.width || 3, h = s.height || 4;
  const k = Math.min(vw / w, vh / h);
  const tw = w * k, th = h * k;
  return { width: tw, height: th, left: (vw - tw) / 2, top: (vh - th) / 2 };
}

function openViewer(s, cell) {
  fromCell = cell || cells.get(s.day) || null;
  load(s);
  $('viewer').hidden = false;

  /* shared-element zoom: the tile you tapped becomes the photo */
  if (fromCell && !still.matches) {
    const from = fromCell.getBoundingClientRect();
    const to = targetRect(s);
    if (to.width && to.height) {
      fromCell.classList.add('ghost');
      const k = Math.max(from.width / to.width, from.height / to.height);
      const dx = (from.left + from.width/2) - (to.left + to.width/2);
      const dy = (from.top + from.height/2) - (to.top + to.height/2);
      animate($('vStage'),
        [{ transform: `translate(${dx}px,${dy}px) scale(${k})`, opacity: .55 },
         { transform: 'none', opacity: 1 }],
        { duration: 400, easing: SNAP });
      animate($('vFade'), [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: 340, delay: 90, easing: SNAP });
    }
  }
}

function closeViewer() {
  const s = cur, cell = fromCell;
  const done = () => { $('viewer').hidden = true; cur = null;
    cell?.classList.remove('ghost'); $('vStage').style.transform = ''; };
  if (!s || !cell || still.matches) return done();
  const from = cell.getBoundingClientRect();
  const to = targetRect(s);
  if (!to.width || !from.width) return done();
  const k = Math.max(from.width / to.width, from.height / to.height);
  const dx = (from.left + from.width/2) - (to.left + to.width/2);
  const dy = (from.top + from.height/2) - (to.top + to.height/2);
  animate($('vFade'), [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'linear' });
  const a = animate($('vStage'),
    [{ transform: 'none', opacity: 1 },
     { transform: `translate(${dx}px,${dy}px) scale(${k})`, opacity: 0 }],
    { duration: 300, easing: SNAP });
  a.finished.then(done).catch(done);
}
$('vClose').onclick = closeViewer;

/* swipe between days — scrubbing your own year is the point of this app */
let sx = 0, sy = 0, dragging = false, axis = null;
const stage = $('vStage');
stage.addEventListener('pointerdown', e => {
  if (!cur) return;
  dragging = true; axis = null; sx = e.clientX; sy = e.clientY;
});
stage.addEventListener('pointermove', e => {
  if (!dragging) return;
  const dx = e.clientX - sx, dy = e.clientY - sy;
  if (!axis && Math.abs(dx) + Math.abs(dy) > 10) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  if (axis === 'x') stage.style.transform = `translateX(${dx * 0.55}px)`;
});
const endDrag = e => {
  if (!dragging) return;
  dragging = false;
  const dx = (e.clientX ?? sx) - sx;
  stage.style.transition = 'transform .32s ' + SPRING;
  stage.style.transform = '';
  setTimeout(() => { stage.style.transition = ''; }, 340);
  if (axis !== 'x' || Math.abs(dx) < 55) return;
  const i = snaps.indexOf(cur);
  const next = snaps[dx < 0 ? i + 1 : i - 1];   // newest first, so left = older
  if (!next) return;
  navigator.vibrate?.(8);
  fromCell = cells.get(next.day) || null;
  load(next);
  animate(stage, [{ transform: `translateX(${dx < 0 ? 40 : -40}px)`, opacity: .4 },
                  { transform: 'none', opacity: 1 }], { duration: 300, easing: SNAP });
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

$('vDel').onclick = async () => {
  if (!cur || !confirm('Delete this snap?')) return;
  const day = cur.day;
  closeViewer();
  await cloud.remove(day);
  snaps = snaps.filter(s => s.day !== day);
  localStorage.setItem('snapz_index', JSON.stringify(snaps));
  paint();
};

/* ================= TIME-LAPSE ================= */
let lapseTimer, frames = [], recorder = null, LW = 1080, LH = 1440;
$('playBtn').onclick = async () => {
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

/* ---- export: verifiable, not just pretty ---- */
$('menu').onclick = () => {
  const out = {
    exported: new Date().toISOString(),
    source: cloud.apiBase(),
    note: 'Each entry lists the R2 object key and its byte count so this export can be checked against the bucket.',
    count: snaps.length,
    snaps
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = 'snapz-metadata.json'; a.click();
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
  } catch (e) {
    $('lockErr').hidden = true; void $('lockErr').offsetWidth;
    $('lockErr').textContent = String(e.message || e); $('lockErr').hidden = false;
  }
  finally { $('lockGo').disabled = false; $('lockGo').textContent = 'Continue'; }
}
$('lockGo').onclick = doLogin;
$('lockPass').addEventListener('keydown', e => e.key === 'Enter' && doLogin());
$('lockSkip').onclick = () => { $('login').hidden = true; localStorage.setItem('snapz_nocloud','1'); };

let press = null;
$('toGallery').addEventListener('pointerdown', () => {
  press = setTimeout(async () => {
    press = null;
    navigator.vibrate?.(14);
    if (!cloud.getToken()) { localStorage.removeItem('snapz_nocloud'); return showLogin(); }
    const c = prompt('Type: days · test · passcode · signout · api', '');
    if (c === 'test') {
      if (lifted()) localStorage.removeItem(TEST); else localStorage.setItem(TEST, '1');
      alert(lifted() ? 'Lock lifted (testing).' : 'Lock restored.');
      return wall();
    }
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
  if (!$('viewer').hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const n = snaps[snaps.indexOf(cur) + (e.key === 'ArrowRight' ? 1 : -1)];
    if (n) { fromCell = cells.get(n.day) || null; load(n); }
    return;
  }
  if (e.key !== 'Escape') return;
  if (!$('lapse').hidden) $('lClose').onclick();
  else if (!$('wall').hidden) $('wallBack').onclick();
  else if (!$('viewer').hidden) closeViewer();
  else show('cam');
});

/* ================= START ================= */
if ('serviceWorker' in navigator)
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
addEventListener('online', async () => { await cloud.flush(); refresh(); });
addEventListener('offline', () => { paintCount(); alertBar(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !stream) startCam();
});
addEventListener('pagehide', () => stream?.getTracks().forEach(t => t.stop()));

startCam();
refresh();
cloud.flush();
if (!cloud.getToken() && !localStorage.getItem('snapz_nocloud')) showLogin();
