/* SnapZ — personal daily selfie camera + gallery
   Storage: IndexedDB (image blobs + metadata), 100% local to your device. */

const $ = id => document.getElementById(id);
const DB_NAME = 'snapz', STORE = 'snaps';

/* ---------------- IndexedDB ---------------- */
let dbp = new Promise((res, rej) => {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
};
const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = v => tx('readwrite', s => s.put(v));
const dbDel = id => tx('readwrite', s => s.delete(id));
const dbClear = () => tx('readwrite', s => s.clear());

/* ---------------- state ---------------- */
let stream = null, facing = 'user', shotBlob = null, shotMeta = null;
let snaps = [], urls = new Map();

const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { weekday:'short', year:'numeric', month:'short', day:'numeric' });
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', second:'2-digit' });
const dayKey  = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const say = (msg, cls = '') => { const s = $('status'); s.textContent = msg; s.className = 'status ' + cls; };

function urlFor(s) {
  if (!urls.has(s.id)) urls.set(s.id, URL.createObjectURL(s.blob));
  return urls.get(s.id);
}

/* ---------------- tabs ---------------- */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('view-' + t.dataset.view).classList.add('active');
});

/* ---------------- camera ---------------- */
async function startCam() {
  try {
    stopCam();
    say('Requesting camera…');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1706 } }, audio: false
    });
    $('video').srcObject = stream;
    $('video').style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';
    $('stageMsg').hidden = true;
    $('btnShot').disabled = false; $('btnFlip').disabled = false;
    $('btnStart').textContent = 'Restart camera';
    say('Camera live — smile 🙂', 'ok');
  } catch (e) {
    say('Camera blocked: ' + e.message + ' (needs HTTPS + permission)', 'err');
  }
}
function stopCam(){ if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }

$('btnStart').onclick = startCam;
$('btnFlip').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCam(); };

/* live clock */
setInterval(() => { if (!shotBlob) $('mTime').textContent = fmtTime(Date.now()); }, 1000);

/* ---------------- geolocation ---------------- */
function getPos() {
  return new Promise(res => {
    if (!$('geoOn').checked || !navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }),
      () => res(null), { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 });
  });
}
async function placeName(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${lat}&lon=${lon}`,
      { headers: { 'Accept': 'application/json' } });
    const j = await r.json();
    const a = j.address || {};
    return [a.suburb || a.neighbourhood || a.road, a.city || a.town || a.village || a.county, a.country]
      .filter(Boolean).join(', ') || j.display_name || '';
  } catch { return ''; }
}

/* ---------------- capture ---------------- */
$('btnShot').onclick = async () => {
  const v = $('video'), c = $('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  if (facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(v, 0, 0, c.width, c.height);

  $('flash').classList.remove('go'); void $('flash').offsetWidth; $('flash').classList.add('go');

  shotBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  const ts = Date.now();
  shotMeta = { ts };

  $('preview').src = URL.createObjectURL(shotBlob);
  $('preview').hidden = false; $('video').hidden = true;
  $('btnSave').hidden = false; $('btnRetake').hidden = false;
  $('btnShot').hidden = true; $('btnFlip').hidden = true; $('btnStart').hidden = true;
  $('mTime').textContent = fmtTime(ts);

  $('mLoc').textContent = $('geoOn').checked ? 'locating…' : 'off';
  const pos = await getPos();
  if (pos) {
    shotMeta.lat = pos.lat; shotMeta.lon = pos.lon; shotMeta.acc = pos.acc;
    $('mLoc').textContent = `${pos.lat}, ${pos.lon} (±${pos.acc}m)`;
    const name = await placeName(pos.lat, pos.lon);
    if (name) { shotMeta.place = name; $('mLoc').textContent = name; }
  } else if ($('geoOn').checked) {
    $('mLoc').textContent = 'unavailable';
  }
  say('Looking good? Hit Save snap.', 'ok');
};

function resetShot() {
  shotBlob = null; shotMeta = null;
  $('preview').hidden = true; $('video').hidden = false;
  $('btnSave').hidden = true; $('btnRetake').hidden = true;
  $('btnShot').hidden = false; $('btnFlip').hidden = false; $('btnStart').hidden = false;
  $('mLoc').textContent = 'not captured';
}
$('btnRetake').onclick = () => { resetShot(); say(''); };

$('btnSave').onclick = async () => {
  if (!shotBlob) return;
  const rec = {
    id: 'snap_' + shotMeta.ts + '_' + Math.random().toString(36).slice(2, 7),
    ts: shotMeta.ts, day: dayKey(shotMeta.ts),
    lat: shotMeta.lat ?? null, lon: shotMeta.lon ?? null, acc: shotMeta.acc ?? null,
    place: shotMeta.place || '', note: '', blob: shotBlob, type: 'image/jpeg'
  };
  await dbPut(rec);
  await refresh();
  resetShot();
  say('Saved ✓  (' + snaps.length + ' total)', 'ok');
};

/* ---------------- stats + gallery ---------------- */
function streakOf(list) {
  const days = new Set(list.map(s => s.day));
  let n = 0, d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // grace: today not shot yet
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

async function refresh() {
  snaps = (await dbAll()).sort((a, b) => b.ts - a.ts);
  $('statTotal').textContent = snaps.length;
  $('statStreak').textContent = streakOf(snaps);
  const today = snaps.filter(s => s.day === dayKey(Date.now())).length;
  $('statToday').textContent = today ? '✓ ' + today : '—';
  $('countBadge').textContent = snaps.length;
  render();
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const list = snaps.filter(s => !q ||
    (s.place + ' ' + s.note + ' ' + fmtDate(s.ts) + ' ' + s.day).toLowerCase().includes(q));
  $('empty').style.display = list.length ? 'none' : 'block';
  $('grid').innerHTML = '';
  list.forEach(s => {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<img loading="lazy" src="${urlFor(s)}" alt="">
      <div class="c-meta"><div class="c-date">${fmtDate(s.ts)}</div>
      <div class="c-loc">${fmtTime(s.ts)} · ${s.place || (s.lat ? s.lat + ', ' + s.lon : 'no location')}</div></div>`;
    el.onclick = () => openLB(s);
    $('grid').appendChild(el);
  });
}
$('search').oninput = render;

/* ---------------- lightbox ---------------- */
let cur = null;
function openLB(s) {
  cur = s;
  const u = urlFor(s);
  $('lbImg').src = u;
  $('lbDate').textContent = fmtDate(s.ts);
  $('lbTime').textContent = fmtTime(s.ts) + '  ·  ' + new Date(s.ts).toISOString();
  $('lbLoc').textContent = s.place ? `${s.place} (${s.lat}, ${s.lon})` : (s.lat ? `${s.lat}, ${s.lon} ±${s.acc}m` : 'No location recorded');
  $('lbLink').href = u; $('lbLink').textContent = u.slice(0, 48) + '…';
  $('lbDl').href = u; $('lbDl').download = `snapz-${s.day}-${new Date(s.ts).toTimeString().slice(0,8).replace(/:/g,'')}.jpg`;
  $('lbMap').href = s.lat ? `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}` : '#';
  $('lbMap').style.display = s.lat ? '' : 'none';
  $('lbNote').value = s.note || '';
  $('lightbox').hidden = false;
}
$('lbClose').onclick = () => { $('lightbox').hidden = true; cur = null; };
$('lightbox').onclick = e => { if (e.target === $('lightbox')) $('lbClose').onclick(); };
$('lbNote').oninput = async () => { if (cur) { cur.note = $('lbNote').value; await dbPut(cur); } };
$('lbCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('lbLink').href); $('lbCopy').textContent = 'Copied!';
    setTimeout(() => $('lbCopy').textContent = 'Copy link', 1400); } catch {}
};
$('lbDel').onclick = async () => {
  if (!cur || !confirm('Delete this snap permanently?')) return;
  await dbDel(cur.id); urls.delete(cur.id);
  $('lightbox').hidden = true; cur = null; await refresh();
};

/* ---------------- export / wipe ---------------- */
$('btnExport').onclick = async () => {
  const rows = await Promise.all(snaps.map(async s => ({
    id: s.id, date: fmtDate(s.ts), time: fmtTime(s.ts), iso: new Date(s.ts).toISOString(),
    lat: s.lat, lon: s.lon, accuracy_m: s.acc, place: s.place, note: s.note,
    map: s.lat ? `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}` : null,
    image: await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(s.blob); })
  })));
  const b = new Blob([JSON.stringify({ app: 'SnapZ', exported: new Date().toISOString(), snaps: rows }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = `snapz-export-${dayKey(Date.now())}.json`; a.click();
};
$('btnWipe').onclick = async () => {
  if (!confirm('Delete ALL snaps? This cannot be undone.')) return;
  await dbClear(); urls.clear(); await refresh();
};

/* go */
refresh();
$('mTime').textContent = fmtTime(Date.now());
