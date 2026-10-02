/* /gallery — everything you can look at. Renders in full at all times; the
   wall is the only thing that stands in front of it. */

import * as cloud from './api.js';
import { $, SPRING, SNAP, still, isOpen, locked, lifted,
         nextClose, windowMins, hhmm, fmtDate, fmtShort, fmtTime,
         fmtMonth, today, mb, registerSW, win } from './shared.js';

let snaps = [], cursor = null, more = false, total = 0, loading = false;
const cells = new Map();                 // snap id -> grid element, for the zoom
let ready = false;
const animate = (el, frames, opts) => {
  if (!el || still.matches || !ready) return { finished: Promise.resolve() };
  return el.animate(frames, { fill: 'both', ...opts });
};

/* ================= DATA ================= */
async function refresh() {
  snaps = cloud.cachedList();            // instant paint from the last index
  cursor = null; more = false;
  paint();
  if (!cloud.getToken() || !navigator.onLine) return;
  try { await cloud.getWindow(); } catch {}
  try {
    const d = await cloud.list({ limit: PAGE });
    snaps = d.snaps; cursor = d.cursor; more = d.more; total = d.total;
    paint();
  } catch (e) {
    if (e instanceof cloud.Closed) { wall(); return; }   // the server says no
    if (String(e.message) === 'unauthorized') location.replace('/lock?next=/gallery');
  }
}

const PAGE = 60;
/* Older snaps arrive as you reach the bottom — the DOM never holds the whole
   archive at once. */
async function loadMore() {
  if (loading || !more || !cursor) return;
  loading = true;
  $('more').hidden = false;
  try {
    const d = await cloud.list({ limit: PAGE, before: cursor });
    snaps = snaps.concat(d.snaps); cursor = d.cursor; more = d.more; total = d.total;
    paint();
  } catch {} finally { loading = false; $('more').hidden = true; }
}
const sentinel = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) loadMore(); },
  { rootMargin: '600px' });

/* An honest ledger, not a statistic: how much is recorded, and whether the
   record has holes. */
function ledger() {
  const el = $('ledger');
  if (!snaps.length) { el.hidden = true; return; }
  const days = [...new Set(snaps.map(s => s.day))].sort();
  let gap = null;
  for (let i = days.length - 1; i > 0; i--) {
    const d = Math.round((new Date(days[i]) - new Date(days[i-1])) / 86400000);
    if (d > 1) { gap = days[i]; break; }
  }
  const bytes = snaps.reduce((n, s) => n + (s.bytes || 0), 0);
  const span = gap ? `unbroken since ${fmtShort(new Date(gap).getTime())}`
                   : `no missing days since ${fmtShort(new Date(days[0]).getTime())}`;
  const n = total || snaps.length;
  el.innerHTML = `<b>${n} snap${n === 1 ? '' : 's'} over ${days.length} day${days.length === 1 ? '' : 's'}</b> · ${span} · ${mb(bytes)}${more ? '+' : ''}`;
  el.hidden = false;
}

/* Failures are stated, never swallowed. */
async function alertBar() {
  const el = $('alert');
  const q = await cloud.pending();
  if (!q.length) { el.hidden = true; return; }
  const worst = q.reduce((a, b) => (b.tries || 0) > (a.tries || 0) ? b : a);
  el.innerHTML = '';
  const txt = document.createElement('span');
  txt.textContent = (worst.tries || 0) > 0
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
    const n = total || snaps.length;
    const days = new Set(snaps.map(s => s.day)).size;
    $('gcount').textContent = n
      ? `${n} ${n === 1 ? 'Photo' : 'Photos'}${days ? ` · ${days} ${days === 1 ? 'Day' : 'Days'}` : ''}`
        + (q.length ? ` · ${q.length} pending` : '') + (navigator.onLine ? '' : ' · Offline')
      : (navigator.onLine ? 'No photos yet' : 'Offline');
  });
}

let firstPaint = true;
function paint() {
  $('playBtn').hidden = snaps.length < 2;
  paintCount(); alertBar(); wall(); closingSoon(); ledger();
  $('empty').hidden = snaps.length > 0;

  const grid = $('grid');
  grid.innerHTML = '';
  cells.clear();

  const td = today();
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
    /* Today's snaps wear a bright green edge — readable straight through the
       wall, so proof of today's upload never depends on reading any text. */
    cell.className = s.day === td ? 'cell today' : 'cell';
    const i = new Image();
    i.src = s.thumb_url || s.url;        // ~20 KB, not the full photo
    i.loading = 'lazy'; i.decoding = 'async'; i.alt = '';
    i.onload = () => i.classList.add('in');
    if (i.complete) i.classList.add('in');
    const d = document.createElement('span');
    d.className = 'dnum'; d.textContent = fmtTime(s.ts);
    cell.append(i, d);
    cell.onclick = () => openViewer(s, cell);
    if (firstPaint && n < 12 && !still.matches) {
      cell.classList.add('enter');
      cell.style.animationDelay = (n * 22) + 'ms';
    }
    grid.appendChild(cell);
    cells.set(s.id, cell);
    n++;
  }
  firstPaint = false;
  $('more').hidden = !more;
  if (more) sentinel.observe($('more')); else sentinel.disconnect();
}

/* The large title collapses into a compact bar, and timestamps appear only
   once you stop scrolling. */
let restTimer;
const gal = $('gal');
gal.addEventListener('scroll', () => {
  $('nav').classList.toggle('solid', gal.scrollTop > 26);
  $('grid').classList.remove('rest');
  clearTimeout(restTimer);
  restTimer = setTimeout(() => $('grid').classList.add('rest'), 220);
}, { passive: true });

$('toCam').onclick = () => location.href = '/';

/* ================= THE WALL ================= */
let wallTimer;
const onPhotoScreen = () => true;        // this whole page is the gallery

function wall() {
  const w = $('wall');
  $('testChip').hidden = !lifted();
  $('wallTest').checked = lifted();
  if (!locked()) { w.hidden = true; clearInterval(wallTimer); return; }
  w.hidden = false;
}

/* The window closes as well as opens — watch the clock, not just the load. */
let wasOpen = isOpen();
setInterval(() => {
  const now = isOpen();
  if (now === wasOpen) return;
  wasOpen = now;
  if (!now && !lifted()) {               // just shut
    if (!$('lapse').hidden) $('lClose').onclick();
    if (!$('viewer').hidden) closeViewer();
  }
  wall();
  if (now) refresh();
}, 1000);

/* A quiet note while the window is open, so the close never ambushes you. */
function closingSoon() {
  const el = $('closing');
  if (!isOpen() || lifted()) { el.hidden = true; return; }
  const mins = Math.round((nextClose() - Date.now()) / 60000);
  el.hidden = mins > 30;
  if (mins <= 30) el.textContent = mins <= 1 ? 'Closing in under a minute'
    : `Closes in ${mins} minutes · ${hhmm(windowMins()[1])}`;
}
setInterval(closingSoon, 20000);

$('wallBack').onclick = () => location.href = '/';
/* The switch is a server setting now, so lifting it really does open the API. */
async function setLift(on) {
  $('wallTest').disabled = true;
  try { await cloud.setWindow({ lift: on }); await refresh(); }
  catch { alert('Could not reach the server.'); }
  finally { $('wallTest').disabled = false; wall(); }
}
$('wallTest').onchange = e => { navigator.vibrate?.(12); setLift(e.target.checked); };
$('testChip').onclick = () => setLift(false);

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
    $('vOpen').href = s.url || '#'; $('vOpen').hidden = !s.url;
    $('vDl').href = s.url || '#'; $('vDl').hidden = !s.url;
    $('vDl').download = `snapz-${s.id}.webp`;
    $('vPos').textContent = `${snaps.indexOf(s) + 1} of ${snaps.length}`;
    fade.classList.remove('swap');
  }, still.matches ? 0 : 200);
}

function load(s) {
  cur = s;
  $('vImg').src = s.thumb_url || s.url;          // show instantly…
  if (s.url) {                                   // …then full resolution, if the
    const full = new Image();                    //    server is handing it out
    full.onload = () => { if (cur === s) $('vImg').src = s.url; };
    full.src = s.url;
  }
  fill(s);
}

/* Where the photo will land, computed rather than measured — the image may not
   have decoded yet when the zoom has to start. */
function targetRect(s) {
  const vw = innerWidth, vh = innerHeight;
  const w = s.width || 3, h = s.height || 4;
  const k = Math.min(vw / w, vh / h);
  return { width: w * k, height: h * k, left: (vw - w*k) / 2, top: (vh - h*k) / 2 };
}

function openViewer(s, cell) {
  fromCell = cell || cells.get(s.id) || null;
  load(s);
  $('viewer').hidden = false;
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
         { transform: 'none', opacity: 1 }], { duration: 400, easing: SNAP });
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

/* swipe between snaps */
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
  const next = snaps[snaps.indexOf(cur) + (dx < 0 ? 1 : -1)];   // newest first
  if (!next) return;
  navigator.vibrate?.(8);
  fromCell = cells.get(next.id) || null;
  load(next);
  animate(stage, [{ transform: `translateX(${dx < 0 ? 40 : -40}px)`, opacity: .4 },
                  { transform: 'none', opacity: 1 }], { duration: 300, easing: SNAP });
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

/* Deletion is reversible: the row is flagged, the bytes survive 30 days. */
let undoTimer;
$('vDel').onclick = async () => {
  if (!cur) return;
  const snap = cur, id = snap.id;
  closeViewer();
  snaps = snaps.filter(s => s.id !== id);
  cloud.cacheList(snaps);
  paint();
  try { await cloud.remove(id); } catch { }
  toast('Snap deleted', 'Undo', async () => {
    try { await cloud.restore(id); } catch {}
    await refresh();
  });
};

function toast(msg, actionLabel, action) {
  const t = $('toast');
  clearTimeout(undoTimer);
  t.innerHTML = '';
  const s = document.createElement('span'); s.textContent = msg;
  t.appendChild(s);
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.onclick = async () => { t.hidden = true; clearTimeout(undoTimer); await action(); };
    t.appendChild(b);
  }
  t.hidden = false;
  undoTimer = setTimeout(() => { t.hidden = true; }, 9000);
}

/* ================= TIME-LAPSE ================= */
let lapseTimer, frames = [], recorder = null, LW = 1080, LH = 1440;
/* Playback uses the ~20 KB thumbnails. Loading hundreds of full-resolution
   photos just to watch them flicker would stall the phone. */
const loadImg = src => new Promise(r => {
  const i = new Image(); i.crossOrigin = 'anonymous';
  i.onload = () => r(i); i.onerror = () => r(null); i.src = src;
});
$('playBtn').onclick = async () => {
  const ordered = [...snaps].reverse();
  $('playBtn').disabled = true;
  frames = (await Promise.all(ordered.map(async s =>
    ({ img: await loadImg(s.thumb_url || s.url), ts: s.ts, full: s.url }))))
    .filter(f => f.img);
  $('playBtn').disabled = false;
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
  recorder.start();
  /* The export is the one place that deserves full resolution. Each frame is
     fetched just before it is drawn, then released. */
  let n = 0;
  for (const f of frames) {
    $('lSave').textContent = `Rendering ${++n}/${frames.length}`;
    const full = (f.full && await loadImg(f.full)) || f.img;
    paintFrame(g, { img: full, ts: f.ts }, LW, LH);
    await new Promise(r => setTimeout(r, 1000/fps));
  }
  await new Promise(r => setTimeout(r, 250));
  recorder.stop();
};

/* ---- export: verifiable, not just pretty ---- */
$('menu').onclick = () => {
  const out = {
    exported: new Date().toISOString(),
    source: cloud.apiBase(),
    note: 'Each entry lists the R2 object key and its byte count so this export can be checked against the bucket.',
    count: snaps.length, snaps
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = 'snapz-metadata.json'; a.click();
};

document.addEventListener('keydown', e => {
  if (!$('viewer').hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const n = snaps[snaps.indexOf(cur) + (e.key === 'ArrowRight' ? 1 : -1)];
    if (n) { fromCell = cells.get(n.id) || null; load(n); }
    return;
  }
  if (e.key !== 'Escape') return;
  if (!$('lapse').hidden) $('lClose').onclick();
  else if (!$('viewer').hidden) closeViewer();
  else location.href = '/';
});

/* ================= START ================= */
registerSW();
addEventListener('online', async () => { await cloud.flush(); refresh(); });
addEventListener('offline', () => { paintCount(); alertBar(); });

if (!cloud.getToken()) location.replace('/lock?next=/gallery');
$('grid').classList.add('rest');
wall();
refresh();
requestAnimationFrame(() => { ready = true; });
