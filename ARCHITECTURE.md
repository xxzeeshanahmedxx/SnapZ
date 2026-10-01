# SnapZ — structure

A static, dependency-free web app. **5 files, ~780 lines, 48 KB total.** No build step, no framework, no server, no npm install. You could open it in Notepad and understand the whole thing.

```
SnapZ/
├── index.html      97 lines   markup: 4 screens + the viewfinder
├── styles.css      79 lines   dark UI, safe-area aware, no external fonts
├── app.js         395 lines   the application (ES module)
├── worker.js       55 lines   background thread: processing + encoding
├── enhance.js     153 lines   the image pipeline (pure functions, no DOM)
├── README.md                  what it is and how to run it
└── ARCHITECTURE.md            this file
```

---

## 1. The four screens

All four live in one HTML document as `<section class="screen">`. Only one is visible
at a time — there is no router, no navigation, no page loads.

| Screen | id | What it is |
|---|---|---|
| **Camera** | `#cam` | Fullscreen `<video>` + white shutter, gallery thumb, flip button |
| **Gallery** | `#gal` | 3-column grid of every snap, header shows count + library size |
| **Viewer** | `#viewer` | One photo fullscreen, with the hidden metadata revealed |
| **Time-lapse** | `#lapse` | Plays all snaps oldest→newest, with a speed slider and video export |

Switching is one line — `show(id)` toggles a single `.on` class.
`#viewer` and `#lapse` are overlays, toggled with the `hidden` attribute
(backed by `[hidden]{display:none !important}`, the bug from earlier).

---

## 2. The three threads

This is the important part of the design.

```
  MAIN THREAD                    WORKER THREAD              BROWSER/OS
  ───────────                    ─────────────              ──────────
  tap shutter
      │
      ├─ grab frame ─────────────────────────────────────── camera ISP
      │   (ImageCapture.takePhoto, full megapixels)
      │
      ├─ encode raw JPEG
      ├─ write to IndexedDB  ◄── SAVE HAPPENS HERE ──► photo is already safe
      ├─ update gallery + thumbnail
      └─ shutter re-enabled          ~instant
      │
      └─ postMessage(bitmap) ──────► enhance()
         (transferred, zero-copy)      denoise
                                       white balance
                                       levels
                                       sharpen
                                         │
                                       encodeBest()
                                       WebP q.90 → size check → retry
                                         │
         swap blob in DB  ◄──────────── postMessage(blob)
         refresh gallery
```

**Why it matters:** the photo is saved and the camera is usable again *before* any
processing starts. Earlier this was all sequential on the main thread — that was the
7-second freeze. The heavy work now happens on another core and the result is swapped
in silently when ready.

---

## 3. Data flow of a single snap

```
camera sensor
   └─ ImageCapture.takePhoto()  ← full resolution, phone's own ISP
        └─ aspect-ratio sanity check  ← rejects distorted frames (the "thin face" fix)
             └─ fallback: burst of 3 frames, averaged  ← cancels random noise
                  └─ mirror if front camera
                       └─ save raw → IndexedDB → UI updates
                            └─ worker: enhance() → encodeBest() → WebP
                                 └─ replace blob in IndexedDB
```

Running in parallel, never blocking the shutter:
- `watchPosition()` keeps a GPS fix warm so coordinates are instant at capture time
- reverse-geocoding (OpenStreetMap) fills in the place name afterwards

---

## 4. What a snap actually is

One IndexedDB record per photo, in a single object store `snaps` keyed by `id`:

```js
{
  id:    's1727788800123abc',  // timestamp + random suffix
  ts:    1727788800123,        // epoch ms — the only time source
  day:   '2026-10-01',         // local date, for grouping/streaks
  lat:   31.520370,            // null if location denied
  lon:   74.358749,
  acc:   12,                   // GPS accuracy, metres
  place: 'Gulberg, Lahore, Pakistan',   // reverse-geocoded, filled in late
  blob:  Blob,                 // the actual image bytes
  type:  'image/webp',
  bytes: 487213,
  w: 3000, h: 4000
}
```

The `Blob` is stored directly — IndexedDB handles binary natively, so there's no
base64 bloat (which would cost +33% size). Display URLs are created lazily via
`URL.createObjectURL` and cached in a `Map` so the gallery doesn't leak memory.

---

## 5. The image pipeline (`enhance.js`)

Pure functions, no DOM, no dependencies — which is why it can run in a worker and
be unit-tested in plain Node. Every pass is **O(pixels)** with no per-pixel inner loops.

| Stage | What it fixes | Guard against over-processing |
|---|---|---|
| `averageFrames` | sensor noise | only used when a real still isn't available |
| chroma denoise | coloured speckle | **luminance untouched** → cannot smooth skin |
| white balance | indoor orange cast | 35% strength only |
| auto levels | dull, flat, milky | 70% of full stretch; 0.2% tail clip |
| unsharp mask | capture softness | clamped ±12 levels → no halos |
| saturation | — | **off** |

Statistics are gathered on a subsample (every 16th pixel on large images), and white
balance + levels are fused into three 256-entry lookup tables, so `Math.pow` runs 768
times instead of 36 million.

---

## 6. Storage & privacy

- **IndexedDB** holds everything. Nothing is uploaded; there is no backend and no account.
- `navigator.storage.persist()` is requested at startup so the browser won't evict a
  decades-long archive under disk pressure.
- **One** network call exists in the entire app: an anonymous OpenStreetMap reverse-geocode
  to turn coordinates into a place name. Remove `placeName()` and the app is fully offline.
- **Export** (↓ in the gallery) writes a single JSON file containing every date, time,
  coordinate, place name and the images themselves as base64 — your escape hatch, since
  browser storage is tied to one device.

---

## 7. Deliberate non-choices

- **No framework.** The app is four screens and a canvas; React would be more bytes than the entire app.
- **No build step.** Native ES modules. Edit a file, refresh, done. It will still run in 10 years.
- **No downscaling.** Compression changes the codec, never the pixels.
- **No text on the camera screen.** Time and place are recorded but deliberately hidden until the gallery.

---

## 8. Backend (optional)

The app is fully functional with no backend. Adding one gives durability beyond a
single device.

```
SnapZ/
├── sync.js              frontend: offline-first upload queue
└── api/
    ├── wrangler.toml    D1 + R2 bindings
    ├── schema.sql       one table, `day` is the PRIMARY KEY
    ├── src/index.js     the Worker (5 routes)
    └── README.md        deploy steps
```

**Division of labour:** D1 is a *journal index* (day, time, location, image URL) —
small, queryable, cheap. R2 holds the bytes. Never put images in D1.

**Offline-first ordering** — the network is never in the critical path:

```
capture → IndexedDB → UI updates → shutter ready
                           └→ worker: enhance + compress
                                 └→ POST /api/snap → R2 + D1
                                       └→ mark synced  (retry queue if offline)
```

**One image per day** is enforced in three places: `day` is the D1 primary key, the R2
key is derived from the day (`2026-10-01.webp`), and `save()` replaces any existing
local record for today. Re-shooting replaces; it never duplicates.

Config lives in `localStorage` (`snapz_api`, `snapz_token`) — long-press the gallery
thumbnail to set them. No token means the app simply stays local-only.
