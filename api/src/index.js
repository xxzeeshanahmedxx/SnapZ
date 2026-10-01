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

/* Shared-secret auth. Set with:  wrangler secret put SNAPZ_TOKEN  */
const authed = (req, env) => {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  return env.SNAPZ_TOKEN && t && t === env.SNAPZ_TOKEN;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(req, env) {
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
    if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);

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
};
