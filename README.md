# 📸 SnapZ

A pure camera. Open it, tap the white shutter, done — one selfie a day.

No stats, no forms, no "save" step, nothing on screen but the viewfinder. Behind the glass every snap quietly records **when** and **where** it was taken, so years from now you can look back and see how you looked, what day it was, and where you were standing.

**Live:** https://xxzeeshanahmedxx.github.io/SnapZ/

## The whole app
- **Camera** — fullscreen viewfinder. A white shutter button, a gallery thumbnail bottom-left, a flip button bottom-right. That's it.
- **Tap = saved.** No review screen, no confirmation. Flash + haptic tick and it's in the gallery.
- **Silent metadata** — GPS is kept warm in the background and written to each snap. Never displayed while shooting.
- **Gallery** — a plain 3-column grid of your face over time.
- **Tap a photo** to reveal what was hidden: the full date, the time, the place name, a map link, and the image link.
- **Export** (↓ icon in the gallery) — the full archive as JSON: dates, times, coordinates, place names and the images themselves.

## Eye alignment (MediaPipe Face Mesh)
Every photo is quietly warped on save so your **eyes land on exactly the same two pixels**, using 468-point face landmarks detected on-device.

- **Always on, invisible.** Your first snap sets the anchor; every snap after is rotated, scaled and shifted to match it. Nothing changes about how you shoot.
- **Why:** a stack of selfies where the eyes never move becomes a smooth time-lapse of you ageing, instead of a jittery mess.
- **Guide mode** (face icon, top-right) is optional: a ghost outline of the target position, live nudges — *come closer, straighten up* — and an **auto-shutter** that fires once you hold the pose for ~0.9s. Off by default, so the screen stays bare.
- **▶ Time-lapse** in the gallery plays every snap oldest→newest with a speed slider, and **Save video** renders it to a file.

Face Mesh runs entirely in your browser — no frames are uploaded. It's ~3MB of WASM, fetched from jsDelivr on first load and cached after. If no face is detected the photo is still saved, just unaligned.

## Privacy
Everything lives in your browser's IndexedDB, on your device. Nothing is uploaded. The only network call is an anonymous OpenStreetMap lookup to turn coordinates into a place name.

## Run it
```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
The camera requires a secure context — `localhost` or HTTPS (GitHub Pages is fine). It will not work inside a sandboxed preview frame.

Tip: on your phone, use **Add to Home Screen** — it opens fullscreen like a native camera.
