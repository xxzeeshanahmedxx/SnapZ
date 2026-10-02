# SnapZ — what is connected to what

A camera that quietly remembers when and where. Take as many snaps a day as you
like; they are stored in the cloud and viewable only inside a window you choose.

## 0. Three pages

It is a multi-page app. Each page loads only the code it needs.

| URL | File | Script | What it is |
|---|---|---|---|
| `/lock` | `lock.html` | `login.js` | the passcode screen |
| `/` | `index.html` | `camera.js` | the camera, nothing else |
| `/gallery` | `gallery.html` | `gallery.js` | grid, viewer, time-lapse, the wall |

`shared.js` holds what all three need (the viewing window, date formatting,
service-worker registration); `api.js` is the only module that touches the
network. Visiting `/` or `/gallery` without a token redirects to
`/lock?next=…`, and `/lock` bounces straight back once you are signed in.

## 1. Capture
`camera.js` holds the camera open with `getUserMedia`. Tapping the shutter grabs a
burst of 3 frames, hands them to `worker.js` on a background thread so the UI
never freezes, and gets back two blobs: the **full image** (WebP q0.90, same
pixel dimensions as the sensor — never downscaled) and a **~400 px thumbnail**.

The shutter re-enables as soon as the encode finishes. Reverse-geocoding and the
upload happen afterwards, so there is no waiting.

## 2. Upload
`api.js` posts both blobs in one multipart request. The Worker writes them to R2
**in parallel** and inserts **one D1 row per snap**, with its own id
(`<day>-<ts>-<rand>`). There is no limit per day; `day` is only a grouping
label used by the gallery.

If the request fails, the record goes to the **outbox** (IndexedDB) and is
retried on the next launch or when the device comes back online. The outbox is
the only local copy and it is deleted the moment the upload lands.

## 3. Gallery — cloud only, and paginated
The grid is built from `GET /api/snaps` (D1) and nothing else, **60 at a time**
with a `ts` cursor; older snaps load as you approach the bottom, so the DOM
never holds the whole archive. Each tile is the
**thumbnail** (~20 KB), so a year of photos paints in a moment. The last known list is kept in `localStorage` — **capped at 60 entries and
written through a quota-safe guard** — purely so the grid appears instantly on
open; it is replaced by the real response a moment later. No image is ever read from
local storage.

Opening a photo shows the thumbnail immediately, then swaps in the full image
from R2 once it has loaded. R2 objects are served with a one-year immutable
cache header, so each photo downloads once per device.

## 4. The lock wall

Photos are viewable inside **one window each day — 18:00 to 21:00** by default.
Outside it `/gallery` still renders **completely normally**; the restriction is
a translucent, lightly blurred sheet over the top that says **Locked** and
swallows every tap. No countdown, no clock, no status text — just the wall.

Because the veil is thin, one signal reads straight through it: **today's snaps
carry a bright green border** that pulses gently. That is the credibility
mechanism — you can confirm today's photo reached the cloud without being able
to look at it.

The window is checked every second, so it **shuts on you mid-session**: at
21:00 the viewer and time-lapse close themselves and the wall drops. While the
window is open and fewer than 30 minutes remain, an amber line reads "Closes in
12 minutes · 9:00 PM".

**The window is enforced by the server**, not just the browser: outside it the
Worker withholds every full-resolution link and `/i/` refuses full images.
Changing the phone's clock no longer helps. Set it in **Settings** (long-press
the camera's thumbnail) with two time fields; it is stored in D1 along with your
timezone. Windows crossing midnight work.

**Testing switch.** Settings — and the wall itself — carry a toggle that lifts
the lock. It is a **server** setting now, so lifting it genuinely reopens the
API. While lifted, a loud amber chip sits at the bottom of the gallery.

## 5. Passcode, and who can actually read your photos

Your passcode protects the API. It is PBKDF2-hashed (100k rounds) in D1;
logging in returns a signed token kept for a year. **Login is rate limited** —
four free attempts, then a wait that doubles from 15 seconds up to 15 minutes.

**Images are not public.** `/i/:key` requires an HMAC signature that only an
authenticated list call issues, valid for 7 days, and it obeys the window.
Object keys carry a random suffix so they cannot be guessed. Responses are
cached at Cloudflare's edge, so the second view of a photo never touches R2.

While the window is **shut**, the API still returns metadata and **thumbnail**
links — that is what lets the gallery render behind the wall — but it issues
**no full-resolution URL at all**, and `/i/` refuses any non-thumbnail key.

## 5b. Deletion is reversible

`DELETE /api/snap/:id` only flags the row. The bytes stay in R2 for **30 days**,
the snap appears in `GET /api/trash` with its purge date, and
`POST /api/snap/:id/restore` brings it back. The gallery shows an **Undo** toast
for nine seconds after a delete. A sweep on each list call removes anything past
its 30 days for real.

## 6. Feel — what the motion is doing

Nothing here is decoration; each piece answers a question you would otherwise
have to trust blindly.

- **Shutter** springs with a slight overshoot, so the tap feels mechanical.
- **The captured frame flies into the thumbnail** — the app's one signature
  motion, and the clearest possible statement that the photo went *somewhere*.
- **The thumbnail wears a progress ring.** White while encoding, green filling
  with the real byte progress of the upload, then a check that draws itself when
  **the server** acknowledges. Red if it failed. You never have to wonder.
- **Saved and uploaded are never shown as the same thing.** A queued photo looks
  different from a confirmed one, everywhere.
- **The grid is a timeline:** sticky month headers, tiles fading up in sequence
  on first paint, and the day number appearing on each tile when you stop
  scrolling.
- **Tapping a tile zooms that tile into the viewer** and back out on close, so
  you never lose your place.
- **Swipe left/right in the viewer** moves through the archive; the metadata
  cross-fades rather than jumping.
- Everything animates transform and opacity only, nothing runs before the camera
  is live, and `prefers-reduced-motion` disables all of it.

## 7. Storage keys
`snapz_api`, `snapz_token`, `snapz_index` (cached list for instant paint),
`snapz_hours`, `snapz_testunlock`, `snapz_nocloud`, plus the `snapz-outbox`
IndexedDB database (keyed per queued snap).

## 8. Removed
Face Mesh, the stats dashboard, the PIN screen, WebAuthn/passkeys, the local
photo store and the old `sync.js` two-way sync, and the one-snap-per-day rule are all gone.
