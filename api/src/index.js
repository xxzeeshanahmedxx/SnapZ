/* SnapZ API — Cloudflare Worker. D1 = one row per snap, R2 = the bytes.
 * Any number of snaps per day; `day` is just a label for grouping.
 *
 *   GET    /api/auth/status      is a passcode set yet?
 *   POST   /api/auth/login       { passcode } -> { token }   (first login claims it)
 *   POST   /api/auth/change      { current, next } -> { token }
 *   GET    /api/snaps            everything, newest first
 *   POST   /api/snap             multipart: image, thumb, day, ts, ...  (always inserts)
 *   GET    /api/snap/:id
 *   DELETE /api/snap/:id         removes the row and both R2 objects
 *   GET    /i/:key               image passthrough when the bucket isn't public
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type'
};
const json = (d, status = 200) => new Response(JSON.stringify(d, null, 2), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
});

const enc = new TextEncoder();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const mimeExt = m => (m.split('/')[1] || 'webp').replace('jpeg', 'jpg');
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(
  atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/* ---------- auth: passcode -> signed session token ---------- */
async function hashPass(pass, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)))
                       : crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, k, 256);
  const hex = a => [...new Uint8Array(a)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex(salt)}:${hex(bits)}`;
}
const sameStr = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
const hmacKey = env => crypto.subtle.importKey('raw', enc.encode(env.SNAPZ_TOKEN),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

async function signToken(env, days = 365) {
  const body = b64u(enc.encode(JSON.stringify({ exp: Date.now() + days * 864e5 })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}
async function authed(req, env) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t || !env.SNAPZ_TOKEN) return false;
  if (sameStr(t, env.SNAPZ_TOKEN)) return true;                 // break-glass admin
  const [body, sig] = t.split('.');
  if (!body || !sig) return false;
  if (!await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(sig), enc.encode(body)))
    return false;
  try { return JSON.parse(new TextDecoder().decode(unb64u(body))).exp > Date.now(); }
  catch { return false; }
}

const getCfg = (env, k) => env.DB.prepare('SELECT value FROM config WHERE key=?').bind(k).first();
const setCfg = (env, k, v) => env.DB.prepare(
  'INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
).bind(k, v).run();

export default {
  fetch: (req, env) => handle(req, env)
    .catch(e => json({ error: String(e?.message || e) }, 500))
};

async function handle(req, env) {
  const url = new URL(req.url), p = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  /* ---------- image passthrough ---------- */
  if (p.startsWith('/i/')) {
    const obj = await env.BUCKET.get(decodeURIComponent(p.slice(3)));
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.body, { headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: obj.httpEtag, ...CORS
    }});
  }
  if (!p.startsWith('/api/')) return new Response('SnapZ API', { headers: CORS });

  /* ---------- auth ---------- */
  if (p === '/api/auth/status') return json({ configured: !!(await getCfg(env, 'passcode')) });

  if (p === '/api/auth/login' && req.method === 'POST') {
    const { passcode } = await req.json().catch(() => ({}));
    if (!passcode || String(passcode).length < 4) return json({ error: 'passcode too short' }, 400);
    const row = await getCfg(env, 'passcode');
    if (!row) {                                       // first login claims the account
      await setCfg(env, 'passcode', await hashPass(String(passcode)));
      return json({ ok: true, created: true, token: await signToken(env) });
    }
    const [salt] = row.value.split(':');
    if (!sameStr(await hashPass(String(passcode), salt), row.value))
      return json({ error: 'wrong passcode' }, 401);
    return json({ ok: true, token: await signToken(env) });
  }

  if (p === '/api/auth/change' && req.method === 'POST') {
    const { current, next } = await req.json().catch(() => ({}));
    const row = await getCfg(env, 'passcode');
    if (row) {
      const [salt] = row.value.split(':');
      if (!sameStr(await hashPass(String(current || ''), salt), row.value))
        return json({ error: 'wrong passcode' }, 401);
    }
    if (!next || String(next).length < 4) return json({ error: 'too short' }, 400);
    await setCfg(env, 'passcode', await hashPass(String(next)));
    return json({ ok: true, token: await signToken(env) });
  }

  if (!await authed(req, env)) return json({ error: 'unauthorized' }, 401);

  /* ---------- list ---------- */
  if (p === '/api/snaps' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM snaps ORDER BY ts DESC').all();
    return json({ count: results.length, snaps: results });
  }

  /* ---------- upload: always a new snap ---------- */
  if (p === '/api/snap' && req.method === 'POST') {
    const form = await req.formData();
    const file = form.get('image'), day = String(form.get('day') || '');
    if (!file || typeof file === 'string') return json({ error: 'image required' }, 400);
    if (!DAY.test(day)) return json({ error: 'day must be YYYY-MM-DD' }, 400);

    const ts = Number(form.get('ts')) || Date.now();
    const ext = mimeExt(file.type || 'image/webp');
    const mime = file.type || 'image/webp';
    /* Unique per snap, not per day — several a day is normal now. */
    const id = `${day}-${ts}-${Math.random().toString(36).slice(2, 7)}`;
    const key = `${id}.${ext}`;
    const thumb = form.get('thumb');
    const thumbKey = thumb && typeof thumb !== 'string' ? `t/${id}.webp` : null;

    const meta = ct => ({ httpMetadata: { contentType: ct, cacheControl: 'public, max-age=31536000, immutable' } });
    const bytes = await file.arrayBuffer();
    await Promise.all([
      env.BUCKET.put(key, bytes, meta(mime)),
      thumbKey ? thumb.arrayBuffer().then(b => env.BUCKET.put(thumbKey, b, meta('image/webp'))) : null
    ]);

    const base = (env.R2_PUBLIC_BASE || '').replace(/\/$/, '');
    const link = k => base ? `${base}/${k}` : `${url.origin}/i/${encodeURIComponent(k)}`;
    const now = Date.now();
    const num = k => form.get(k) ? Number(form.get(k)) : null;

    await env.DB.prepare(`
      INSERT INTO snaps (id,day,ts,time,tz,lat,lon,accuracy,place,key,url,thumb_key,thumb_url,
                         mime,bytes,width,height,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(id, day, ts, String(form.get('time') || ''), String(form.get('tz') || ''),
            num('lat'), num('lon'), num('accuracy'), String(form.get('place') || ''),
            key, link(key), thumbKey, thumbKey ? link(thumbKey) : link(key),
            mime, bytes.byteLength, num('width'), num('height'), now, now).run();

    return json({ ok: true, snap: await env.DB.prepare('SELECT * FROM snaps WHERE id=?').bind(id).first() });
  }

  /* ---------- one snap ---------- */
  const m = p.match(/^\/api\/snap\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (req.method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM snaps WHERE id=?').bind(id).first();
      return row ? json(row) : json({ error: 'not found' }, 404);
    }
    if (req.method === 'DELETE') {
      const row = await env.DB.prepare('SELECT key,thumb_key FROM snaps WHERE id=?').bind(id).first();
      if (!row) return json({ error: 'not found' }, 404);
      await Promise.all([
        row.key ? env.BUCKET.delete(row.key) : null,
        row.thumb_key ? env.BUCKET.delete(row.thumb_key) : null
      ]);
      await env.DB.prepare('DELETE FROM snaps WHERE id=?').bind(id).run();
      return json({ ok: true, deleted: id });
    }
  }

  return json({ error: 'not found' }, 404);
}
