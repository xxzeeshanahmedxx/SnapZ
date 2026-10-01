import { verifyRegistration, verifyAssertion, b64u as wb64u, unb64u as wunb64u } from './webauthn.js';
/* SnapZ API — Cloudflare Worker
   D1 holds one row per day; R2 holds the image bytes.

   POST   /api/snap        upload (multipart) → upserts today's row
   GET    /api/snaps       list all days, newest first
   GET    /api/snap/:day   one day
   DELETE /api/snap/:day   remove row + R2 object
   GET    /i/:key          serve image (only used when R2_PUBLIC_BASE is unset)
*/

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors(), ...extra }
  });

const cors = () => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type'
});

/* ---------------------------------------------------------------
   Auth: you type a passcode you chose; the device gets a long-lived
   signed session token. The passcode is never stored — only a salted
   PBKDF2 hash of it, in D1. SNAPZ_TOKEN is the signing key (and still
   works directly, as a break-glass admin credential).
   --------------------------------------------------------------- */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(
  atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function hashPass(pass, saltHex) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  const sh = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${sh}:${hex}`;
}
const timingSafe = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

async function signToken(env, days = 365) {
  const body = b64u(enc.encode(JSON.stringify({ exp: Date.now() + days * 864e5 })));
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SNAPZ_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${b64u(sig)}`;
}
async function verifyToken(env, tok) {
  const [body, sig] = (tok || '').split('.');
  if (!body || !sig) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SNAPZ_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, unb64u(sig), enc.encode(body));
  if (!ok) return false;
  try { return JSON.parse(new TextDecoder().decode(unb64u(body))).exp > Date.now(); }
  catch { return false; }
}

const bearer = req => {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};
const authed = async (req, env) => {
  const t = bearer(req);
  if (!t || !env.SNAPZ_TOKEN) return false;
  if (timingSafe(t, env.SNAPZ_TOKEN)) return true;    // admin token
  return verifyToken(env, t);                          // session token
};

const getCfg = (env, k) => env.DB.prepare('SELECT value FROM config WHERE key = ?').bind(k).first();
const setCfg = (env, k, v) => env.DB.prepare(
  'INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
).bind(k, v).run();

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* ---- WebAuthn config ---- */
const rpIdOf = env => env.RP_ID || 'snapz.catdevelopers.com';
const originsOf = env => (env.ORIGINS || 'https://snapz.catdevelopers.com')
  .split(',').map(s => s.trim()).filter(Boolean);

async function newChallenge(env) {
  const c = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO challenges (challenge, expires) VALUES (?,?)')
    .bind(c, Date.now() + 300000).run();
  return c;
}
async function takeChallenge(env, c) {
  const row = await env.DB.prepare('SELECT expires FROM challenges WHERE challenge = ?').bind(c).first();
  await env.DB.prepare('DELETE FROM challenges WHERE challenge = ? OR expires < ?')
    .bind(c, Date.now()).run();
  return !!row && row.expires > Date.now();
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (err) { return json({ error: String(err?.message || err) }, 500); }
  }
};

async function handle(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    /* ---- public image passthrough (when the bucket isn't public) ---- */
    if (p.startsWith('/i/')) {
      const key = decodeURIComponent(p.slice(3));
      const obj = await env.BUCKET.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'content-type': obj.httpMetadata?.contentType || 'image/webp',
          'cache-control': 'public, max-age=31536000, immutable',
          'etag': obj.httpEtag,
          ...cors()
        }
      });
    }

    if (!p.startsWith('/api/')) return new Response('SnapZ API', { status: 200, headers: cors() });

    /* ---- is a passcode set yet? (lets the app show Create vs Enter) ---- */
    if (p === '/api/auth/status' && req.method === 'GET') {
      const row = await getCfg(env, 'passcode');
      return json({ configured: !!row });
    }

    /* ---- log in, or claim the account on first use ---- */
    if (p === '/api/auth/login' && req.method === 'POST') {
      const { passcode } = await req.json().catch(() => ({}));
      if (!passcode || String(passcode).length < 4)
        return json({ error: 'passcode must be at least 4 characters' }, 400);

      const row = await getCfg(env, 'passcode');
      if (!row) {                                   // first ever login sets it
        await setCfg(env, 'passcode', await hashPass(String(passcode)));
        return json({ ok: true, created: true, token: await signToken(env) });
      }
      const [salt] = row.value.split(':');
      const attempt = await hashPass(String(passcode), salt);
      if (!timingSafe(attempt, row.value)) return json({ error: 'wrong passcode' }, 401);
      return json({ ok: true, token: await signToken(env) });
    }

    /* ---- change the passcode (requires the current one) ---- */
    if (p === '/api/auth/change' && req.method === 'POST') {
      const { current, next } = await req.json().catch(() => ({}));
      const row = await getCfg(env, 'passcode');
      if (row) {
        const [salt] = row.value.split(':');
        if (!timingSafe(await hashPass(String(current || ''), salt), row.value))
          return json({ error: 'wrong passcode' }, 401);
      }
      if (!next || String(next).length < 4) return json({ error: 'too short' }, 400);
      await setCfg(env, 'passcode', await hashPass(String(next)));
      return json({ ok: true, token: await signToken(env) });
    }

    /* ================= PASSKEYS (fingerprint / Face ID) ================= */

    /* how is this account protected? */
    if (p === '/api/auth/methods' && req.method === 'GET') {
      const pc = await getCfg(env, 'passcode');
      const { results } = await env.DB.prepare(
        'SELECT id, name, created_at, last_used FROM credentials').all();
      return json({ passcode: !!pc, passkeys: results.length, devices: results });
    }

    /* --- register a new passkey (requires an existing session) --- */
    if (p === '/api/webauthn/register/options' && req.method === 'POST') {
      if (!(await authed(req, env))) return json({ error: 'unauthorized' }, 401);
      const { results } = await env.DB.prepare('SELECT id FROM credentials').all();
      return json({
        challenge: await newChallenge(env),
        rp: { id: rpIdOf(env), name: 'SnapZ' },
        user: { id: b64u(enc.encode('snapz-owner')), name: 'owner', displayName: 'SnapZ' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',       // the phone's own sensor
          residentKey: 'preferred',
          userVerification: 'required'               // fingerprint/Face ID, not just presence
        },
        excludeCredentials: results.map(r => ({ id: r.id, type: 'public-key' })),
        timeout: 60000,
        attestation: 'none'
      });
    }

    if (p === '/api/webauthn/register/verify' && req.method === 'POST') {
      if (!(await authed(req, env))) return json({ error: 'unauthorized' }, 401);
      const body = await req.json();
      if (!(await takeChallenge(env, body.challenge))) return json({ error: 'challenge expired' }, 400);
      const reg = await verifyRegistration({
        attestationObject: unb64u(body.attestationObject),
        clientDataJSON: unb64u(body.clientDataJSON),
        challenge: body.challenge, origins: originsOf(env), rpId: rpIdOf(env)
      });
      await env.DB.prepare(`INSERT INTO credentials (id,pubkey,alg,counter,name,created_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET pubkey=excluded.pubkey,
        counter=excluded.counter, name=excluded.name`)
        .bind(reg.id, reg.pubkey, reg.alg, reg.counter,
              String(body.name || 'This device').slice(0, 40), Date.now()).run();
      return json({ ok: true, id: reg.id });
    }

    /* --- log in with a passkey (no session needed) --- */
    if (p === '/api/webauthn/login/options' && req.method === 'POST') {
      const { results } = await env.DB.prepare('SELECT id FROM credentials').all();
      if (!results.length) return json({ error: 'no passkeys registered' }, 404);
      return json({
        challenge: await newChallenge(env),
        rpId: rpIdOf(env),
        allowCredentials: results.map(r => ({ id: r.id, type: 'public-key' })),
        userVerification: 'required',
        timeout: 60000
      });
    }

    if (p === '/api/webauthn/login/verify' && req.method === 'POST') {
      const body = await req.json();
      if (!(await takeChallenge(env, body.challenge))) return json({ error: 'challenge expired' }, 400);
      const cred = await env.DB.prepare('SELECT * FROM credentials WHERE id = ?').bind(body.id).first();
      if (!cred) return json({ error: 'unknown credential' }, 404);
      const { counter } = await verifyAssertion({
        authenticatorData: unb64u(body.authenticatorData),
        clientDataJSON: unb64u(body.clientDataJSON),
        signature: unb64u(body.signature),
        challenge: body.challenge, origins: originsOf(env), rpId: rpIdOf(env),
        pubkey: cred.pubkey, storedCounter: cred.counter
      });
      await env.DB.prepare('UPDATE credentials SET counter = ?, last_used = ? WHERE id = ?')
        .bind(counter, Date.now(), body.id).run();
      return json({ ok: true, token: await signToken(env) });
    }

    if (p.startsWith('/api/webauthn/device/') && req.method === 'DELETE') {
      if (!(await authed(req, env))) return json({ error: 'unauthorized' }, 401);
      await env.DB.prepare('DELETE FROM credentials WHERE id = ?')
        .bind(decodeURIComponent(p.split('/').pop())).run();
      return json({ ok: true });
    }

    if (!(await authed(req, env))) return json({ error: 'unauthorized' }, 401);

    try {
      /* ---------- list ---------- */
      if (p === '/api/snaps' && req.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM snaps ORDER BY ts DESC'
        ).all();
        return json({ count: results.length, snaps: results });
      }

      /* ---------- upload / replace a day ---------- */
      if (p === '/api/snap' && req.method === 'POST') {
        const form = await req.formData();
        const file = form.get('image');
        const day  = String(form.get('day') || '');
        if (!file || typeof file === 'string') return json({ error: 'image required' }, 400);
        if (!DAY.test(day)) return json({ error: 'day must be YYYY-MM-DD' }, 400);

        const ts   = Number(form.get('ts')) || Date.now();
        const mime = file.type || 'image/webp';
        const ext  = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'webp';
        const key  = `${day}.${ext}`;

        /* the day is the identity: delete any previous object for it */
        const prev = await env.DB.prepare('SELECT key FROM snaps WHERE day = ?').bind(day).first();
        if (prev?.key && prev.key !== key) await env.BUCKET.delete(prev.key);

        const bytes = await file.arrayBuffer();
        await env.BUCKET.put(key, bytes, {
          httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
          customMetadata: { day, ts: String(ts) }
        });

        const base = (env.R2_PUBLIC_BASE || '').replace(/\/$/, '');
        const imgUrl = base ? `${base}/${key}` : `${url.origin}/i/${encodeURIComponent(key)}`;
        const now = Date.now();

        await env.DB.prepare(`
          INSERT INTO snaps (day, ts, time, tz, lat, lon, accuracy, place,
                             key, url, mime, bytes, width, height, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(day) DO UPDATE SET
            ts=excluded.ts, time=excluded.time, tz=excluded.tz,
            lat=excluded.lat, lon=excluded.lon, accuracy=excluded.accuracy,
            place=excluded.place, key=excluded.key, url=excluded.url,
            mime=excluded.mime, bytes=excluded.bytes,
            width=excluded.width, height=excluded.height, updated_at=excluded.updated_at
        `).bind(
          day, ts,
          String(form.get('time') || ''),
          String(form.get('tz') || ''),
          form.get('lat') ? Number(form.get('lat')) : null,
          form.get('lon') ? Number(form.get('lon')) : null,
          form.get('accuracy') ? Number(form.get('accuracy')) : null,
          String(form.get('place') || ''),
          key, imgUrl, mime, bytes.byteLength,
          Number(form.get('width')) || null,
          Number(form.get('height')) || null,
          now, now
        ).run();

        const row = await env.DB.prepare('SELECT * FROM snaps WHERE day = ?').bind(day).first();
        return json({ ok: true, snap: row });
      }

      /* ---------- single day ---------- */
      const m = p.match(/^\/api\/snap\/(\d{4}-\d{2}-\d{2})$/);
      if (m) {
        const day = m[1];
        if (req.method === 'GET') {
          const row = await env.DB.prepare('SELECT * FROM snaps WHERE day = ?').bind(day).first();
          return row ? json(row) : json({ error: 'not found' }, 404);
        }
        if (req.method === 'DELETE') {
          const row = await env.DB.prepare('SELECT key FROM snaps WHERE day = ?').bind(day).first();
          if (row?.key) await env.BUCKET.delete(row.key);
          await env.DB.prepare('DELETE FROM snaps WHERE day = ?').bind(day).run();
          return json({ ok: true, deleted: day });
        }
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
  }
