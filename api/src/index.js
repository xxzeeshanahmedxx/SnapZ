/* SnapZ API — Cloudflare Worker. D1 = one row per snap, R2 = the bytes.
 *
 * Images are NOT public: /i/:key requires a short-lived HMAC signature that
 * only an authenticated list call hands out, and it obeys the viewing window.
 *
 *   GET    /api/auth/status          is a passcode set yet?
 *   POST   /api/auth/login           { passcode } -> { token }   (rate limited)
 *   POST   /api/auth/change          { current, next } -> { token }
 *   GET    /api/window               { from, to, tz, lift, open }
 *   POST   /api/window               set any of from/to/tz/lift
 *   GET    /api/snaps?limit&before   newest first, paginated
 *   POST   /api/snap                 multipart; always inserts; never gated
 *   GET    /api/snap/:id
 *   DELETE /api/snap/:id             soft delete, recoverable for 30 days
 *   POST   /api/snap/:id/restore     undo a delete
 *   GET    /api/trash                what is recoverable, and until when
 *   GET    /i/:key?e=&s=             signed image
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
const TRASH_DAYS = 30;
const URL_TTL = 7 * 86400;               // signed image lifetime, seconds
const mimeExt = m => (m.split('/')[1] || 'webp').replace('jpeg', 'jpg');
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(
  atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/* ---------- crypto ---------- */
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
const mac = async (env, msg) =>
  b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(msg)));

async function signToken(env, days = 365) {
  const body = b64u(enc.encode(JSON.stringify({ exp: Date.now() + days * 864e5 })));
  return `${body}.${await mac(env, body)}`;
}
const isAdmin = (req, env) => {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  return !!t && !!env.SNAPZ_TOKEN && sameStr(t, env.SNAPZ_TOKEN);
};
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

/* ---------- signed image links ---------- */
const imgSig = (env, key, exp) => mac(env, `img:${key}:${exp}`);
async function imgLink(env, origin, key) {
  if (!key) return null;
  const base = (env.R2_PUBLIC_BASE || '').replace(/\/$/, '');
  if (base) return `${base}/${key}`;
  const exp = Math.floor(Date.now() / 1000) + URL_TTL;
  return `${origin}/i/${encodeURIComponent(key)}?e=${exp}&s=${await imgSig(env, key, exp)}`;
}
async function withLinks(env, origin, rows, full = true) {
  return Promise.all(rows.map(async r => ({
    ...r,
    /* When the window is shut the full image is simply not handed out. */
    url: full ? await imgLink(env, origin, r.key) : null,
    thumb_url: await imgLink(env, origin, r.thumb_key || r.key)
  })));
}

/* ---------- config ---------- */
const getCfg = async (env, k) =>
  (await env.DB.prepare('SELECT value FROM config WHERE key=?').bind(k).first())?.value ?? null;
const setCfg = (env, k, v) => env.DB.prepare(
  'INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
).bind(k, String(v)).run();
const getJSON = async (env, k, dflt) => {
  try { const v = await getCfg(env, k); return v ? JSON.parse(v) : dflt; } catch { return dflt; }
};

/* ---------- the viewing window, enforced here and not just in the browser ---------- */
const DEFAULT_WIN = { from: '18:00', to: '21:00', tz: 'Asia/Karachi', lift: false };
const toMins = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1]*60 + +m[2] : 0; };

function minsInTz(tz) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const h = +p.find(x => x.type === 'hour').value, m = +p.find(x => x.type === 'minute').value;
    return (h % 24) * 60 + m;
  } catch { return new Date().getUTCHours() * 60 + new Date().getUTCMinutes(); }
}
async function windowState(env) {
  const w = { ...DEFAULT_WIN, ...(await getJSON(env, 'window', {})) };
  const o = toMins(w.from), c = toMins(w.to), t = minsInTz(w.tz);
  const inWindow = o <= c ? (t >= o && t < c) : (t >= o || t < c);
  return { ...w, open: !!w.lift || inWindow };
}

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx)
    .catch(e => json({ error: String(e?.message || e) }, 500))
};

async function handle(req, env, ctx) {
  const url = new URL(req.url), p = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  /* ---------- signed image delivery ---------- */
  if (p.startsWith('/i/')) {
    const key = decodeURIComponent(p.slice(3));
    const admin = isAdmin(req, env);
    if (!admin) {
      const exp = Number(url.searchParams.get('e') || 0);
      const sig = url.searchParams.get('s') || '';
      if (!exp || exp * 1000 < Date.now()) return new Response('Link expired', { status: 403, headers: CORS });
      if (!sameStr(sig, await imgSig(env, key, exp))) return new Response('Bad signature', { status: 403, headers: CORS });
      /* Thumbnails stay available when the window is shut: the gallery is
         meant to render behind the wall. Full-resolution images do not. */
      const w = await windowState(env);
      if (!w.open && !key.startsWith('t/'))
        return new Response('Closed', { status: 423, headers: CORS });
    }

    /* Edge cache: the second view of a photo never reaches R2. */
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/i/${encodeURIComponent(key)}`, req);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const obj = await env.BUCKET.get(key);
    if (!obj) return new Response('Not found', { status: 404, headers: CORS });
    const res = new Response(obj.body, { headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: obj.httpEtag, ...CORS
    }});
    ctx?.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }

  if (!p.startsWith('/api/')) return new Response('SnapZ API', { headers: CORS });

  /* ---------- auth ---------- */
  if (p === '/api/auth/status') return json({ configured: !!(await getCfg(env, 'passcode')) });

  if (p === '/api/auth/login' && req.method === 'POST') {
    /* Rate limit: a 4-character passcode is a small keyspace. */
    const lock = await getJSON(env, 'login_lock', { fails: 0, until: 0 });
    if (lock.until > Date.now())
      return json({ error: `too many attempts · wait ${Math.ceil((lock.until - Date.now())/1000)}s`,
                    retryAfter: Math.ceil((lock.until - Date.now())/1000) }, 429);

    const { passcode } = await req.json().catch(() => ({}));
    if (!passcode || String(passcode).length < 4) return json({ error: 'passcode too short' }, 400);
    const stored = await getCfg(env, 'passcode');

    if (!stored) {                                   // first login claims the account
      await setCfg(env, 'passcode', await hashPass(String(passcode)));
      await setCfg(env, 'login_lock', JSON.stringify({ fails: 0, until: 0 }));
      return json({ ok: true, created: true, token: await signToken(env) });
    }
    const [salt] = stored.split(':');
    if (!sameStr(await hashPass(String(passcode), salt), stored)) {
      const fails = (lock.fails || 0) + 1;
      /* nothing for the first 4, then 15s doubling to 15 minutes */
      const wait = fails <= 4 ? 0 : Math.min(15000 * 2 ** (fails - 5), 900000);
      await setCfg(env, 'login_lock', JSON.stringify({ fails, until: Date.now() + wait }));
      return json({ error: 'wrong passcode', attempt: fails }, 401);
    }
    await setCfg(env, 'login_lock', JSON.stringify({ fails: 0, until: 0 }));
    return json({ ok: true, token: await signToken(env) });
  }

  if (p === '/api/auth/change' && req.method === 'POST') {
    const { current, next } = await req.json().catch(() => ({}));
    const stored = await getCfg(env, 'passcode');
    if (stored) {
      const [salt] = stored.split(':');
      if (!sameStr(await hashPass(String(current || ''), salt), stored))
        return json({ error: 'wrong passcode' }, 401);
    }
    if (!next || String(next).length < 4) return json({ error: 'too short' }, 400);
    await setCfg(env, 'passcode', await hashPass(String(next)));
    return json({ ok: true, token: await signToken(env) });
  }

  if (!await authed(req, env)) return json({ error: 'unauthorized' }, 401);

  /* ---------- the window ---------- */
  if (p === '/api/window') {
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const cur = { ...DEFAULT_WIN, ...(await getJSON(env, 'window', {})) };
      for (const k of ['from', 'to'])
        if (body[k] != null && /^\d{1,2}:\d{2}$/.test(body[k])) cur[k] = body[k];
      if (typeof body.tz === 'string' && body.tz) cur.tz = body.tz;
      if (typeof body.lift === 'boolean') cur.lift = body.lift;
      await setCfg(env, 'window', JSON.stringify(cur));
    }
    return json(await windowState(env));
  }

  const win = await windowState(env);
  const admin = isAdmin(req, env);
  const shut = () => json({ error: 'closed', closed: true,
    window: { from: win.from, to: win.to, tz: win.tz } }, 423);

  /* ---------- list (paginated) ---------- */
  if (p === '/api/snaps' && req.method === 'GET') {
    /* Metadata and thumbnails are always listed — the gallery renders behind
       the wall by design. Full-resolution links are withheld when shut. */

    /* Purge anything that has sat in the trash past its 30 days. */
    ctx?.waitUntil(purge(env));

    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 200);
    const before = Number(url.searchParams.get('before')) || null;
    const q = before
      ? env.DB.prepare('SELECT * FROM snaps WHERE deleted_at IS NULL AND ts < ? ORDER BY ts DESC LIMIT ?').bind(before, limit + 1)
      : env.DB.prepare('SELECT * FROM snaps WHERE deleted_at IS NULL ORDER BY ts DESC LIMIT ?').bind(limit + 1);
    const { results } = await q.all();
    const more = results.length > limit;
    const page = results.slice(0, limit);
    const total = (await env.DB.prepare('SELECT COUNT(*) n FROM snaps WHERE deleted_at IS NULL').first())?.n ?? page.length;
    return json({ count: page.length, total, more, open: win.open || admin,
                  cursor: more ? page[page.length - 1].ts : null,
                  snaps: await withLinks(env, url.origin, page, win.open || admin) });
  }

  /* ---------- trash ---------- */
  if (p === '/api/trash' && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM snaps WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all();
    return json({ count: results.length, keepDays: TRASH_DAYS,
                  snaps: (await withLinks(env, url.origin, results)).map(r => ({
                    ...r, purges_at: r.deleted_at + TRASH_DAYS * 86400000 })) });
  }

  /* ---------- upload: never gated, always a new snap ---------- */
  if (p === '/api/snap' && req.method === 'POST') {
    const form = await req.formData();
    const file = form.get('image'), day = String(form.get('day') || '');
    if (!file || typeof file === 'string') return json({ error: 'image required' }, 400);
    if (!DAY.test(day)) return json({ error: 'day must be YYYY-MM-DD' }, 400);

    const ts = Number(form.get('ts')) || Date.now();
    const mime = file.type || 'image/webp';
    const id = `${day}-${ts}-${Math.random().toString(36).slice(2, 7)}`;
    const key = `${id}.${mimeExt(mime)}`;
    const thumb = form.get('thumb');
    const thumbKey = thumb && typeof thumb !== 'string' ? `t/${id}.webp` : null;

    const meta = ct => ({ httpMetadata: { contentType: ct, cacheControl: 'public, max-age=31536000, immutable' } });
    const bytes = await file.arrayBuffer();
    await Promise.all([
      env.BUCKET.put(key, bytes, meta(mime)),
      thumbKey ? thumb.arrayBuffer().then(b => env.BUCKET.put(thumbKey, b, meta('image/webp'))) : null
    ]);

    /* The device's zone is the source of truth for the window. */
    const tz = String(form.get('tz') || '');
    if (tz) {
      const cur = { ...DEFAULT_WIN, ...(await getJSON(env, 'window', {})) };
      if (cur.tz !== tz) await setCfg(env, 'window', JSON.stringify({ ...cur, tz }));
    }

    const now = Date.now();
    const num = k => form.get(k) ? Number(form.get(k)) : null;
    await env.DB.prepare(`
      INSERT INTO snaps (id,day,ts,time,tz,lat,lon,accuracy,place,key,url,thumb_key,thumb_url,
                         mime,bytes,width,height,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(id, day, ts, String(form.get('time') || ''), tz,
            num('lat'), num('lon'), num('accuracy'), String(form.get('place') || ''),
            key, '', thumbKey, '', mime, bytes.byteLength, num('width'), num('height'), now, now).run();

    const row = await env.DB.prepare('SELECT * FROM snaps WHERE id=?').bind(id).first();
    return json({ ok: true, snap: (await withLinks(env, url.origin, [row]))[0] });
  }

  /* ---------- one snap ---------- */
  let m = p.match(/^\/api\/snap\/(.+?)\/restore$/);
  if (m && req.method === 'POST') {
    const id = decodeURIComponent(m[1]);
    const r = await env.DB.prepare('UPDATE snaps SET deleted_at=NULL WHERE id=?').bind(id).run();
    return r.meta.changes ? json({ ok: true, restored: id }) : json({ error: 'not found' }, 404);
  }

  m = p.match(/^\/api\/snap\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (req.method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM snaps WHERE id=? AND deleted_at IS NULL').bind(id).first();
      return row ? json((await withLinks(env, url.origin, [row], win.open || admin))[0])
                 : json({ error: 'not found' }, 404);
    }
    if (req.method === 'DELETE') {
      /* Soft delete. The bytes survive for TRASH_DAYS so a mis-tap is survivable. */
      const purgeNow = url.searchParams.get('purge') === '1';
      const row = await env.DB.prepare('SELECT key,thumb_key FROM snaps WHERE id=?').bind(id).first();
      if (!row) return json({ error: 'not found' }, 404);
      if (purgeNow) {
        await Promise.all([
          row.key ? env.BUCKET.delete(row.key) : null,
          row.thumb_key ? env.BUCKET.delete(row.thumb_key) : null
        ]);
        await env.DB.prepare('DELETE FROM snaps WHERE id=?').bind(id).run();
        return json({ ok: true, purged: id });
      }
      await env.DB.prepare('UPDATE snaps SET deleted_at=? WHERE id=?').bind(Date.now(), id).run();
      return json({ ok: true, deleted: id, recoverableFor: TRASH_DAYS + ' days' });
    }
  }

  return json({ error: 'not found' }, 404);
}

/* Anything deleted longer ago than TRASH_DAYS really goes. */
async function purge(env) {
  const cut = Date.now() - TRASH_DAYS * 86400000;
  const { results } = await env.DB.prepare(
    'SELECT id,key,thumb_key FROM snaps WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(cut).all();
  for (const r of results) {
    await Promise.all([
      r.key ? env.BUCKET.delete(r.key) : null,
      r.thumb_key ? env.BUCKET.delete(r.thumb_key) : null
    ]);
    await env.DB.prepare('DELETE FROM snaps WHERE id=?').bind(r.id).run();
  }
}
