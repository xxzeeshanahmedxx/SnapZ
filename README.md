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
Cheap phone sensors are noisy, soft and badly white-balanced. Every snap runs through a pipeline that fixes what software can:

1. **Full-resolution stills** — uses `ImageCapture.takePhoto()` to pull a real photo from the camera's own ISP at maximum megapixels, instead of grabbing a low-res preview frame. Biggest single win.
2. **Continuous autofocus / auto-exposure / auto-white-balance** forced on via track constraints.
3. **Multi-frame noise reduction** — where stills aren't supported, 5 frames are captured and averaged. Noise is random and cancels out; your face doesn't. Same principle as phone "night mode".
4. **Gray-world white balance** — removes the orange indoor-bulb cast.
5. **Auto levels + shadow lift** — stretches a flat, milky histogram to full contrast without blowing highlights.
6. **Unsharp mask on luminance only** — restores detail from a soft lens without amplifying colour noise.
7. **Gentle saturation**, then saved at JPEG quality 0.95.

All of it is silent and automatic. Tuning lives at the top of `enhance.js`.

## Privacy
Everything lives in your browser's IndexedDB, on your device. Nothing is uploaded. The only network call is an anonymous OpenStreetMap lookup to turn coordinates into a place name.

## Run it
```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
The camera requires a secure context — `localhost` or HTTPS (GitHub Pages is fine). It will not work inside a sandboxed preview frame.

Tip: on your phone, use **Add to Home Screen** — it opens fullscreen like a native camera.
