# SnapZ backend — Cloudflare Worker + D1 + R2

**D1** stores one row per day. **R2** stores the image bytes. The Worker is the only
thing that touches either.

```
phone ──POST /api/snap──► Worker ──┬─► R2    (image bytes, key = 2026-10-01.webp)
                                   └─► D1    (day, ts, time, location, url)
```

## Secrets vs. bindings vs. identifiers

| Value | What it is | Where it lives | In git? |
|---|---|---|---|
| `SNAPZ_TOKEN` | **the only real credential** | `wrangler secret put` (encrypted at Cloudflare) | never |
| Cloudflare API token | grants account access | `wrangler login`, on your machine | never |
| `database_id`, `bucket_name` | **bindings** — resource names | `wrangler.toml`, generated from `.env` | no (git-ignored) |
| `R2_PUBLIC_BASE` | a public URL | `[vars]` | harmless |

**Why the D1/R2 IDs can't be secrets.** They're *bindings*, not runtime values.
Wrangler reads them at **deploy** time to wire `env.DB` and `env.BUCKET` to real
resources; by the time the Worker executes there is no ID to resolve. `wrangler secret`
injects values at **runtime** — the wrong half of the lifecycle. Wrangler will refuse to
deploy without a literal `database_id`.

**They're also not credentials.** D1 has no public endpoint — it is reachable only from a
Worker bound to it inside your account, or through the Cloudflare API with your account
token. Per Cloudflare's own guidance, a database ID "is not a secret": it *names* a
database, it doesn't open one.

Still, they're yours, so `wrangler.toml` is **git-ignored and generated** from `api/.env`
by `./deploy.sh`. Nothing identifying your account is committed.

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

# 5. put your IDs in .env (git-ignored), then ship
cp .env.example .env     # paste the database_id + bucket name
./deploy.sh              # generates wrangler.toml, then deploys
```

`deploy.sh` regenerates `wrangler.toml` from `.env` every run, so the committed tree
never contains your resource IDs. For local development put `SNAPZ_TOKEN=...` in
`api/.dev.vars` (also git-ignored) and run `wrangler dev`.

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
