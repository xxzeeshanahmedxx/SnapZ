/* Off-main-thread image processing + encoding.
   The UI never blocks on a photo, and nothing is downscaled — we only ever
   change the CODEC, never the pixels. */
import { enhance } from './enhance.js';

/* Preference order. WebP is ~30-50% smaller than JPEG at matching quality and
   encodes fast; AVIF is smaller still but can take many seconds for a 12MP
   frame on a phone, so it's only used when explicitly asked for. */
const CHAIN = [
  { type: 'image/webp', q: 0.90 },
  { type: 'image/jpeg', q: 0.95 }
];

const TARGET   = 1.5 * 1024 * 1024;   // soft size budget per photo
const Q_FLOOR  = 0.82;                // never go below this — quality first
const Q_STEP   = 0.04;

async function encodeBest(cv, preferAvif) {
  const chain = preferAvif ? [{ type: 'image/avif', q: 0.68 }, ...CHAIN] : CHAIN;

  for (const { type, q } of chain) {
    let quality = q, best = null;
    for (;;) {
      let blob;
      try { blob = await cv.convertToBlob({ type, quality }); } catch { break; }
      /* browsers silently fall back to PNG when a codec is unsupported */
      if (!blob || blob.type !== type) break;
      best = blob;
      if (blob.size <= TARGET || quality <= Q_FLOOR) break;
      quality = Math.max(Q_FLOOR, quality - Q_STEP);    // nudge down, re-encode
    }
    if (best) return best;
  }
  return cv.convertToBlob({ type: 'image/jpeg', quality: 0.92 });  // last resort
}

/* A small thumbnail is what makes the gallery feel instant: the grid loads
   ~20 KB per photo instead of ~500 KB. */
const THUMB = 400;
async function makeThumb(cv) {
  const s = THUMB / Math.max(cv.width, cv.height);
  if (s >= 1) return cv.convertToBlob({ type: 'image/webp', quality: 0.8 });
  const t = new OffscreenCanvas(Math.round(cv.width * s), Math.round(cv.height * s));
  const g = t.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(cv, 0, 0, t.width, t.height);
  return t.convertToBlob({ type: 'image/webp', quality: 0.8 });
}

self.onmessage = async e => {
  const { id, bitmap, avif = false } = e.data;
  try {
    const w = bitmap.width, h = bitmap.height;
    const cv = new OffscreenCanvas(w, h);
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const img = g.getImageData(0, 0, w, h);
    enhance(img, w, h);          // denoise first — clean pixels compress far better
    g.putImageData(img, 0, 0);

    const [blob, thumb] = await Promise.all([encodeBest(cv, avif), makeThumb(cv)]);
    self.postMessage({ id, blob, thumb, type: blob.type, w, h });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
