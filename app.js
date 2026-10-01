/* SnapZ — a pure camera.
   Tap the shutter, it's saved. Time + place are recorded silently in the
   background and only ever shown later, in the gallery. */

const $ = id => document.getElementById(id);
const DB = 'snapz', STORE = 'snaps';
const inFrame = window.self !== window.top;

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
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
const dayKey = ts => { const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

let snaps = [], urls = new Map(), stream = null, facing = 'user', busy = false;
const urlFor = s => { if (!urls.has(s.id)) urls.set(s.id, URL.createObjectURL(s.blob)); return urls.get(s.id); };

/* ---------------- silent location ----------------
   Kept warm in the background so saving a snap is instant. Never rendered
   on the camera screen — it's only written to the record. */
let lastPos = null;
if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    p => { lastPos = { lat:+p.coords.latitude.toFixed(6), lon:+p.coords.longitude.toFixed(6),
                       acc: Math.round(p.coords.accuracy), at: Date.now() }; },
    () => {}, { enableHighAccuracy:true, maximumAge:120000, timeout:20000 });
}
async function placeName(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${lat}&lon=${lon}`);
    const a = (await r.json()).address || {};
    return [a.suburb || a.neighbourhood || a.road, a.city || a.town || a.village || a.county, a.country]
      .filter(Boolean).join(', ');
  } catch { return ''; }
}

/* ---------------- camera ---------------- */
function showFallback(msg, retry = true) {
  $('fallback').hidden = false;
  $('fbMsg').textContent = msg;
  $('fbRetry').hidden = !retry;
  $('fbTab').hidden = !inFrame;
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

/* ---------------- capture = save, no review ---------------- */
$('shutter').onclick = async () => {
  if (!stream || busy) return;
  busy = true;
  const v = $('video'), c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext('2d');
  if (facing === 'user') { g.translate(c.width, 0); g.scale(-1, 1); }
  g.drawImage(v, 0, 0, c.width, c.height);

  $('flash').classList.remove('go'); void $('flash').offsetWidth; $('flash').classList.add('go');
  if (navigator.vibrate) navigator.vibrate(18);

  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  await save(blob, Date.now());
  busy = false;
};
$('pick').onchange = async e => { const f = e.target.files[0]; if (f) await save(f, Date.now()); e.target.value = ''; };

async function save(blob, ts) {
  const rec = { id:'s'+ts+Math.random().toString(36).slice(2,6), ts, day:dayKey(ts),
    lat:lastPos?.lat ?? null, lon:lastPos?.lon ?? null, acc:lastPos?.acc ?? null,
    place:'', blob, type:'image/jpeg' };
  await dbPut(rec);
  await load();                       // thumbnail updates immediately
  if (rec.lat != null) {              // resolve the place name afterwards, quietly
    const n = await placeName(rec.lat, rec.lon);
    if (n) { rec.place = n; await dbPut(rec); await load(); }
  }
}

/* ---------------- gallery ---------------- */
async function load() {
  snaps = (await dbAll()).sort((a,b) => b.ts - a.ts);
  $('gcount').textContent = snaps.length ? snaps.length + (snaps.length === 1 ? ' snap' : ' snaps') : '';
  const t = $('toGallery');
  if (snaps[0]) { t.style.backgroundImage = `url(${urlFor(snaps[0])})`; t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop'); }
  else t.style.backgroundImage = '';
  $('empty').hidden = snaps.length > 0;
  $('grid').innerHTML = '';
  snaps.forEach(s => { const i = new Image();
    i.src = urlFor(s); i.loading = 'lazy'; i.onclick = () => openViewer(s); $('grid').appendChild(i); });
}

const show = id => document.querySelectorAll('.screen').forEach(s =>
  s.id === 'viewer' ? 0 : s.classList.toggle('on', s.id === id));
$('toGallery').onclick = () => show('gal');
$('toCam').onclick = () => show('cam');

/* ---------------- viewer ---------------- */
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
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!$('viewer').hidden) $('vClose').onclick(); else show('cam'); }
});

/* ---------------- export (the "look back" archive) ---------------- */
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

/* ---------------- go ---------------- */
load();
startCam();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !stream) startCam();
});
window.addEventListener('pagehide', () => stream && stream.getTracks().forEach(t => t.stop()));
