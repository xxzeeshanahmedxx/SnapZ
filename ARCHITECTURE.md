# SnapZ — what is connected to what

A daily selfie camera. One photo per day, stored in the cloud, with the time and
place recorded silently and shown only in the gallery viewer.

```
  PHONE                                CLOUDFLARE
  ─────                                ──────────
  index.html   markup, every screen
      │
      ├─ styles.css
      │
      ├─ app.js ──────── camera, gallery, viewer, time-lapse, day gate
      │     │
      │     ├─ worker.js ──── background thread: burst average, denoise,
      │     │     └ enhance.js   white balance, levels, WebP encode + thumbnail
      │     │
      │     └─ api.js ─────── the ONLY code that touches the network
      │            │                     │
      │            │  POST /api/snap ────┼──▶ Worker (api/src/index.js)
      │            │  GET  /api/snaps ───┤        │
      │            │  DELETE /api/snap/… ┤        ├──▶ R2  snapz-photos   (bytes)
      │            │                     │        └──▶ D1  snapz          (metadata)
      │            └─ outbox (IndexedDB) — failed uploads only
      │
      └─ sw.js ──── caches the app shell so the camera opens offline
```

## 1. Capture
`app.js` holds the camera open with `getUserMedia`. Tapping the shutter grabs a
burst of 3 frames, hands them to `worker.js` on a background thread so the UI
never freezes, and gets back two blobs: the **full image** (WebP q0.90, same
pixel dimensions as the sensor — never downscaled) and a **~400 px thumbnail**.

The shutter re-enables as soon as the encode finishes. Reverse-geocoding and the
upload happen afterwards, so there is no waiting.

## 2. Upload
`api.js` posts both blobs in one multipart request. The Worker writes them to R2
**in parallel** and upserts one row in D1 keyed by the local date — re-shooting
on the same day replaces that day instead of adding a second entry.

If the request fails, the record goes to the **outbox** (IndexedDB) and is
retried on the next launch or when the device comes back online. The outbox is
the only local copy and it is deleted the moment the upload lands.

## 3. Gallery — cloud only
The grid is built from `GET /api/snaps` (D1) and nothing else. Each tile is the
**thumbnail** (~20 KB), so a year of photos paints in a moment. The last known
list is kept in `localStorage` purely so the grid appears instantly on open; it
is replaced by the real response a moment later. No image is ever read from
local storage.

Opening a photo shows the thumbnail immediately, then swaps in the full image
from R2 once it has loaded. R2 objects are served with a one-year immutable
cache header, so each photo downloads once per device.

## 4. Day gate
Instead of a lock, the gallery simply does not open except on your chosen days
(default **Friday and Sunday**, stored in `localStorage.snapz_days`, changeable
from the long-press menu). On a closed day the grid renders zero images, the
thumbnail button is blank, and a screen counts down to the next open day and
dismisses itself at midnight. **Capture is never gated** — you can always take
the day's photo.

## 5. Passcode
Your passcode protects the **API**, not the phone. It is PBKDF2-hashed in D1;
logging in returns a signed token kept in `localStorage` for a year. Without it,
nobody can read your photos even with the API URL.

## 6. Storage keys
`snapz_api`, `snapz_token`, `snapz_index` (cached list for instant paint),
`snapz_days`, `snapz_nocloud`, plus the `snapz-outbox` IndexedDB database.

## 7. Removed
Face Mesh, the stats dashboard, the PIN screen, WebAuthn/passkeys, the local
photo store and the old `sync.js` two-way sync are all gone.
