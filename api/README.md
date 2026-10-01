# SnapZ backend — Cloudflare Worker + D1 + R2

**D1** stores one row per day. **R2** stores the image bytes. The Worker is the only
thing that touches either.

```
phone ──POST /api/snap──► Worker ──┬─► R2    (image bytes, key = 2026-10-01.webp)
                                   └─► D1    (day, ts, time, location, url)
```

## Deploy (about 5 minutes)

```bash
cd api
npm i -g wrangler
wrangler login

# 1. create the database — copy the printed database_id into wrangler.toml
wrangler d1 create snapz

# 2. create the bucket
wrangler r2 bucket create snapz-photos

# 3. create the table
wrangler d1 execute snapz --remote --file=./schema.sql

# 4. set your private access token (invent a long random string)
wrangler secret put SNAPZ_TOKEN

# 5. ship it
wrangler deploy
```

Wrangler prints a URL like `https://snapz-api.<you>.workers.dev`.

### Point the app at it
In SnapZ, **long-press the gallery thumbnail** (~0.7s) and enter:
1. the Worker URL
2. the same `SNAPZ_TOKEN`

Both are stored in `localStorage`. Existing unsynced days upload immediately.

### Optional: serve images straight from R2
Cheaper and faster than proxying through the Worker. Attach a custom domain to the
bucket (R2 → Settings → Public access), then set in `wrangler.toml`:

```toml
R2_PUBLIC_BASE = "https://img.catdevelopers.com"
```

and `wrangler deploy` again. New rows get direct R2 URLs; without it, images are
served by the Worker at `/i/<key>`.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/snap` | multipart upload; **upserts** the row for that `day` |
| `GET` | `/api/snaps` | all days, newest first |
| `GET` | `/api/snap/:day` | one day (`YYYY-MM-DD`) |
| `DELETE` | `/api/snap/:day` | delete the row **and** the R2 object |
| `GET` | `/i/:key` | image passthrough (no auth — the key is unguessable-ish) |

All `/api/*` routes require `Authorization: Bearer <SNAPZ_TOKEN>`.

```bash
curl -H "Authorization: Bearer $SNAPZ_TOKEN" https://snapz-api.you.workers.dev/api/snaps
```

## One image per day
`day` is the **primary key**. Shooting twice on the same date overwrites that day —
in D1, in R2 (the old object is deleted), and in the local gallery. Your archive is
exactly one row per calendar day, which is what makes the time-lapse honest.

## Cost
Free tier covers this comfortably: D1 allows 5 GB storage and 5 M reads/day; R2 gives
10 GB storage with **zero egress fees**. One ~500 KB photo a day is ~180 MB/year.

## Offline behaviour
The phone always writes to IndexedDB first and never waits for the network. Failed
uploads are queued in `localStorage` and retried automatically when the connection
returns (and on app start). The gallery header shows `N to upload` when anything is
pending.
