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

## Image quality
The goal is **the photo your phone took, minus the noise and the dullness** — no skin smoothing, no beauty filter, no saturation pumping.

1. **Full-resolution stills** — `ImageCapture.takePhoto()` pulls a real photo from the camera's ISP at max megapixels instead of grabbing a low-res preview frame.
2. **Continuous autofocus / exposure / white balance** forced on via track constraints.
3. **Multi-frame noise reduction** — where stills aren't supported, 3 frames are averaged. Noise is random and cancels; detail doesn't move.
4. **Chroma denoise** — sensor noise is mostly coloured speckle in the shadows. The colour channels are smoothed while **luminance is left completely untouched**, so grain disappears and not one real detail softens. Measured: 85% less colour noise, edge contrast unchanged (140.9 → 140.7).
5. **Gentle white balance** (35% strength) — removes an obvious indoor cast without shifting skin tone.
6. **Partial auto-levels** (70% of the full stretch, 1.04 shadow lift) — fixes dullness, stops short of looking processed.
7. **Clamped unsharp** (±12 levels, luma only) — undoes capture softness without halos or crunch.
8. Saturation is **off**.

### Compression
Full resolution is always preserved — only the codec changes, never the pixels.

- Encodes to **WebP q0.90**, falling back to JPEG q0.95 if unsupported. Same visual quality, typically **30–50% smaller files**.
- If a photo still exceeds a 1.5 MB budget, quality steps down in 0.04 increments — but **never below 0.82**, so quality always wins over size.
- Denoising runs *before* encoding: clean pixels compress dramatically better, so noise reduction is itself a compression win.
- The gallery header shows your total library size, and persistent storage is requested so the browser can't evict the archive.

Everything runs in a Web Worker so the shutter never blocks. All constants are the defaults at the top of `enhance()` in `enhance.js` — set `sharpen: 0` or `chroma: 0` to disable a stage.

## Privacy
Everything lives in your browser's IndexedDB, on your device. Nothing is uploaded. The only network call is an anonymous OpenStreetMap lookup to turn coordinates into a place name.

## Run it
```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
The camera requires a secure context — `localhost` or HTTPS (GitHub Pages is fine). It will not work inside a sandboxed preview frame.

Tip: on your phone, use **Add to Home Screen** — it opens fullscreen like a native camera.
