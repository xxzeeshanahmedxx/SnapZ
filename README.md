# 📸 SnapZ

A tiny personal web app: take a selfie every day, and it records the **time**, the **location**, and a **link to the image** — plus a gallery of everything you've shot.

**Live:** https://xxzeeshanahmedxx.github.io/SnapZ/ *(enable GitHub Pages → Settings → Pages → Branch `main` / root)*

## Features
- 📷 Live camera (front/back flip, mirrored selfie preview)
- 🕒 Automatic timestamp on every snap
- 📍 GPS coordinates + reverse-geocoded place name (OpenStreetMap Nominatim) + map link
- 🔗 Direct image link per snap — open, copy, or download
- 🖼️ Gallery grid with search, lightbox view and per-day notes
- 🔥 Total snaps + daily streak counter
- 💾 Export everything to JSON (images embedded as base64)
- 🔒 100% local — images live in your browser's IndexedDB, nothing is uploaded anywhere

## Run locally
```bash
python3 -m http.server 8000
# open http://localhost:8000
```
Camera APIs require a **secure context**: `localhost` or HTTPS (GitHub Pages works).

## Files
| File | Purpose |
|---|---|
| `index.html` | Markup / layout |
| `styles.css` | Dark UI theme |
| `app.js` | Camera, geolocation, IndexedDB storage, gallery |

## Notes & possible next steps
- Storage is per-browser/per-device. Use **Export JSON** to back up.
- Image links are `blob:` URLs — valid in the current tab session. For permanent shareable URLs you'd need a backend (e.g. Supabase Storage, Cloudinary, or an S3 bucket).
- Ideas: PWA install + offline, calendar heatmap view, auto daily reminder, timelapse video from all snaps.
