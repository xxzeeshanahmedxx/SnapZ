/* SnapZ — a pure camera with an invisible memory.
   Tap the shutter: the photo is eye-aligned via MediaPipe Face Mesh and saved
   with the time and place, none of which ever appears on the camera screen. */

const $ = id => document.getElementById(id);
const DB = 'snapz', STORE = 'snaps';
const inFrame = window.self !== window.top;

/* Canonical frame: every saved photo is warped so the eyes land here. */
const OUT_W = 1080, OUT_H = 1440;
const EYE_L = { x: 0.355 * OUT_W, y: 0.400 * OUT_H };
const EYE_R = { x: 0.645 * OUT_W, y: 0.400 * OUT_H };
/* Face Mesh landmark indices for the eye corners */
const L_OUT = 33, L_IN = 133, R_IN = 362, R_OUT = 263;

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

let snaps = [], urls = new Map(), stream = null, facing = 'user', busy = false;
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

/* ================= FACE MESH ================= */
let mesh = null, face = null, meshReady = false;
let guide = localStorage.getItem('guide') === '1';

function eyesOf(lm, w, h, mirror) {
  const pt = i => ({ x: (mirror ? 1 - lm[i].x : lm[i].x) * w, y: lm[i].y * h });
  const mid = (a, b) => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });
  // when mirrored, the anatomical left eye appears on the other side — swap so
  // "l" is always the eye on the left of the final image
  const e1 = mid(pt(L_OUT), pt(L_IN)), e2 = mid(pt(R_IN), pt(R_OUT));
  return mirror ? { l:e2, r:e1 } : { l:e1, r:e2 };
}

function initMesh() {
  if (mesh || typeof FaceMesh === 'undefined') return;
  mesh = new FaceMesh({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${f}` });
  mesh.setOptions({ maxNumFaces:1, refineLandmarks:false, minDetectionConfidence:0.5, minTrackingConfidence:0.5 });
  mesh.onResults(r => {
    face = r.multiFaceLandmarks?.[0] || null;
    meshReady = true;
    if (guide) drawGuide();
  });
  pump();
}
let pumping = false;
async function pump() {
  if (pumping) return; pumping = true;
  const loop = async () => {
    const v = $('video');
    if (mesh && v.readyState >= 2 && !document.hidden) {
      try { await mesh.send({ image: v }); } catch {}
    }
    setTimeout(() => requestAnimationFrame(loop), guide ? 0 : 180); // idle slower when no guide
  };
  loop();
}

/* ---- the target: eye positions from your first ever snap ---- */
function anchor() {
  try { return JSON.parse(localStorage.getItem('anchor')); } catch { return null; }
}
function setAnchor(a) { localStorage.setItem('anchor', JSON.stringify(a)); }

/* ---- guide overlay + auto-shutter ---- */
let alignedSince = 0;
function drawGuide() {
  const cv = $('overlay'), v = $('video');
  const w = cv.width = cv.clientWidth, h = cv.height = cv.clientHeight;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!guide) return;

  const a = anchor() || { lx:0.355, ly:0.40, rx:0.645, ry:0.40 };
  // target eye positions in display space (video is object-fit:cover)
  const T = { l:{ x:a.lx*w, y:a.ly*h }, r:{ x:a.rx*w, y:a.ry*h } };
  const td = Math.hypot(T.r.x-T.l.x, T.r.y-T.l.y);
  const tc = { x:(T.l.x+T.r.x)/2, y:(T.l.y+T.r.y)/2 };

  let ok = false, msg = 'Find your face';
  if (face) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const sc = Math.max(w/vw, h/vh);                       // object-fit: cover
    const ox = (w - vw*sc)/2, oy = (h - vh*sc)/2;
    const e = eyesOf(face, vw, vh, facing === 'user');
    const L = { x:e.l.x*sc+ox, y:e.l.y*sc+oy }, R = { x:e.r.x*sc+ox, y:e.r.y*sc+oy };
    const d = Math.hypot(R.x-L.x, R.y-L.y), c = { x:(L.x+R.x)/2, y:(L.y+R.y)/2 };
    const dist = Math.hypot(c.x-tc.x, c.y-tc.y) / td;
    const sz = d / td;
    const roll = Math.abs(Math.atan2(R.y-L.y, R.x-L.x) - Math.atan2(T.r.y-T.l.y, T.r.x-T.l.x)) * 180/Math.PI;

    if (sz < 0.85) msg = 'Come closer';
    else if (sz > 1.18) msg = 'Move back';
    else if (dist > 0.22) msg = 'Centre your face';
    else if (roll > 9) msg = 'Straighten up';
    else { ok = true; msg = 'Hold still'; }

    g.save(); g.globalAlpha = .9; g.fillStyle = ok ? '#2ac880' : '#fff';
    [L, R].forEach(p => { g.beginPath(); g.arc(p.x, p.y, 4, 0, 7); g.fill(); });
    g.restore();
  }

  // ghost outline of where the face should sit
  g.save();
  g.translate(tc.x, tc.y);
  g.rotate(Math.atan2(T.r.y-T.l.y, T.r.x-T.l.x));
  g.strokeStyle = ok ? 'rgba(42,200,128,.95)' : 'rgba(255,255,255,.4)';
  g.lineWidth = 2; g.setLineDash(ok ? [] : [7, 7]);
  g.beginPath(); g.ellipse(0, td*0.12, td*1.05, td*1.45, 0, 0, 7); g.stroke();
  g.setLineDash([]);
  [-1, 1].forEach(s => { g.beginPath(); g.arc(s*td/2, 0, 9, 0, 7); g.stroke(); });
  g.restore();

  $('hint').hidden = false;
  $('hint').textContent = msg;
  $('hint').classList.toggle('ok', ok);

  // auto-shutter: hold the pose ~0.9s
  if (ok && !busy) {
    if (!alignedSince) { alignedSince = Date.now(); $('ring').classList.add('spin'); }
    else if (Date.now() - alignedSince > 900) { alignedSince = 0; $('ring').classList.remove('spin'); capture(); }
  } else { alignedSince = 0; $('ring').classList.remove('spin'); }
}

$('guideBtn').onclick = () => {
  guide = !guide;
  localStorage.setItem('guide', guide ? '1' : '0');
  $('guideBtn').classList.toggle('on', guide);
  $('hint').hidden = !guide;
  if (!guide) { $('overlay').getContext('2d').clearRect(0,0,$('overlay').width,$('overlay').height);
                $('ring').classList.remove('spin'); alignedSince = 0; }
  if (guide) initMesh();
};
$('guideBtn').classList.toggle('on', guide);

/* ================= CAMERA ================= */
function showFallback(msg, retry = true) {
  $('fallback').hidden = false; $('fbMsg').textContent = msg;
  $('fbRetry').hidden = !retry; $('fbTab').hidden = !inFrame;
  if (inFrame) $('fbTab').href = location.href;
  $('shutter').disabled = true;
}
async function startCam() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  if (!window.isSecureContext) return showFallback('Camera needs HTTPS or localhost.', false);
  if (!navigator.mediaDevices?.getUserMedia)
    return showFallback(inFrame ? 'Camera is blocked inside this preview frame.' : 'Camera not supported here.', false);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width:{ ideal:1440 }, height:{ ideal:1920 } }, audio:false });
    const v = $('video');
    v.srcObject = stream; await v.play().catch(()=>{});
    v.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';
    $('fallback').hidden = true; $('shutter').disabled = false;
    initMesh();
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

/* ---------------- capture → align → save ---------------- */
async function capture() {
  if (!stream || busy) return;
  busy = true;
  const v = $('video'), mirror = facing === 'user';
  const vw = v.videoWidth, vh = v.videoHeight;

  // raw frame, mirrored to match what you saw
  const raw = document.createElement('canvas');
  raw.width = vw; raw.height = vh;
  const rg = raw.getContext('2d');
  if (mirror) { rg.translate(vw, 0); rg.scale(-1, 1); }
  rg.drawImage(v, 0, 0, vw, vh);

  $('flash').classList.remove('go'); void $('flash').offsetWidth; $('flash').classList.add('go');
  if (navigator.vibrate) navigator.vibrate(18);

  const lm = face;
  let blob, aligned = false;
  if (lm) {
    const e = eyesOf(lm, vw, vh, mirror);
    if (!anchor()) setAnchor({ lx:e.l.x/vw, ly:e.l.y/vh, rx:e.r.x/vw, ry:e.r.y/vh });  // first face sets the target
    blob = await alignToCanonical(raw, e);
    aligned = true;
  } else {
    blob = await new Promise(r => raw.toBlob(r, 'image/jpeg', 0.92));
  }
  await save(blob, Date.now(), aligned);
  busy = false;
}

/* rotate + scale + translate so the eyes land on EYE_L / EYE_R */
function alignToCanonical(src, e) {
  const out = document.createElement('canvas');
  out.width = OUT_W; out.height = OUT_H;
  const g = out.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, OUT_W, OUT_H);

  const srcD = Math.hypot(e.r.x - e.l.x, e.r.y - e.l.y) || 1;
  const dstD = EYE_R.x - EYE_L.x;
  const scale = dstD / srcD;
  const angle = -Math.atan2(e.r.y - e.l.y, e.r.x - e.l.x);  // level the eyes
  const sc = { x:(e.l.x + e.r.x)/2, y:(e.l.y + e.r.y)/2 };
  const dc = { x:(EYE_L.x + EYE_R.x)/2, y:(EYE_L.y + EYE_R.y)/2 };

  g.translate(dc.x, dc.y);
  g.rotate(angle);
  g.scale(scale, scale);
  g.translate(-sc.x, -sc.y);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0);
  return new Promise(r => out.toBlob(r, 'image/jpeg', 0.92));
}

$('pick').onchange = async e => { const f = e.target.files[0]; if (f) await save(f, Date.now(), false); e.target.value = ''; };

async function save(blob, ts, aligned) {
  const rec = { id:'s'+ts+Math.random().toString(36).slice(2,6), ts, day:dayKey(ts),
    lat:lastPos?.lat ?? null, lon:lastPos?.lon ?? null, acc:lastPos?.acc ?? null,
    place:'', aligned, blob, type:'image/jpeg' };
  await dbPut(rec);
  await load();
  if (rec.lat != null) { const n = await placeName(rec.lat, rec.lon);
    if (n) { rec.place = n; await dbPut(rec); await load(); } }
}

/* ================= GALLERY ================= */
async function load() {
  snaps = (await dbAll()).sort((a,b) => b.ts - a.ts);
  $('gcount').textContent = snaps.length ? snaps.length + (snaps.length === 1 ? ' snap' : ' snaps') : '';
  const t = $('toGallery');
  if (snaps[0]) { t.style.backgroundImage = `url(${urlFor(snaps[0])})`;
    t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop'); }
  else t.style.backgroundImage = '';
  $('empty').hidden = snaps.length > 0;
  $('playBtn').hidden = snaps.length < 2;
  $('grid').innerHTML = '';
  snaps.forEach(s => { const i = new Image();
    i.src = urlFor(s); i.loading = 'lazy'; i.onclick = () => openViewer(s); $('grid').appendChild(i); });
}
const show = id => document.querySelectorAll('.screen').forEach(s =>
  (s.id === 'viewer' || s.id === 'lapse') ? 0 : s.classList.toggle('on', s.id === id));
$('toGallery').onclick = () => show('gal');
$('toCam').onclick = () => show('cam');

/* ================= VIEWER ================= */
let cur = null;
function openViewer(s) {
  cur = s; const u = urlFor(s);
  $('vImg').src = u;
  $('vDate').textContent = fmtDate(s.ts);
  $('vTime').textContent = fmtTime(s.ts);
  $('vPlace').textContent = s.place || (s.lat != null ? `${s.lat}, ${s.lon}` : '');
  $('vPlace').hidden = !s.place && s.lat == null;
  $('vMap').hidden = s.lat == null;
  if (s.lat != null) $('vMap').href = `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`;
  $('vOpen').href = u;
  $('vDl').href = u; $('vDl').download = `snapz-${s.day}-${new Date(s.ts).toTimeString().slice(0,5).replace(':','')}.jpg`;
  $('viewer').hidden = false;
}
$('vClose').onclick = () => { $('viewer').hidden = true; cur = null; };
$('vDel').onclick = async () => {
  if (!cur || !confirm('Delete this snap?')) return;
  await dbDel(cur.id); urls.delete(cur.id); $('viewer').hidden = true; cur = null; await load();
};

/* ================= TIME-LAPSE ================= */
let lapseTimer = null, lapseImgs = [], recorder = null;
$('playBtn').onclick = async () => {
  const ordered = [...snaps].reverse();                 // oldest → newest
  lapseImgs = await Promise.all(ordered.map(s => new Promise(r => {
    const i = new Image(); i.onload = () => r({ img:i, ts:s.ts }); i.src = urlFor(s); })));
  $('lapse').hidden = false;
  playLapse();
};
function playLapse() {
  const cv = $('lapseCv'); cv.width = OUT_W; cv.height = OUT_H;
  const g = cv.getContext('2d');
  let i = 0;
  clearInterval(lapseTimer);
  const tick = () => {
    const f = lapseImgs[i % lapseImgs.length];
    g.fillStyle = '#000'; g.fillRect(0, 0, OUT_W, OUT_H);
    g.drawImage(f.img, 0, 0, OUT_W, OUT_H);
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
  const cv = document.createElement('canvas'); cv.width = OUT_W; cv.height = OUT_H;
  const g = cv.getContext('2d');
  const strm = cv.captureStream(fps);
  const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const chunks = [];
  recorder = new MediaRecorder(strm, { mimeType: mime, videoBitsPerSecond: 6e6 });
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
  for (const f of lapseImgs) {
    g.fillStyle = '#000'; g.fillRect(0, 0, OUT_W, OUT_H);
    g.drawImage(f.img, 0, 0, OUT_W, OUT_H);
    await new Promise(r => setTimeout(r, 1000 / fps));
  }
  await new Promise(r => setTimeout(r, 250));
  recorder.stop();
};

/* ================= EXPORT ================= */
$('menu').onclick = async () => {
  if (!snaps.length) return;
  const rows = await Promise.all(snaps.map(async s => ({
    date: fmtDate(s.ts), time: fmtTime(s.ts), iso: new Date(s.ts).toISOString(),
    lat: s.lat, lon: s.lon, accuracy_m: s.acc, place: s.place, eye_aligned: !!s.aligned,
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

/* ---------------- go ---------------- */
$('hint').hidden = !guide;
load();
startCam();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !stream) startCam();
});
window.addEventListener('pagehide', () => stream && stream.getTracks().forEach(t => t.stop()));
