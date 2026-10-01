/* Off-main-thread image processing: the UI never blocks on a photo. */
import { enhance } from './enhance.js';

self.onmessage = async e => {
  const { id, bitmap, quality = 0.95 } = e.data;
  try {
    const w = bitmap.width, h = bitmap.height;
    const cv = new OffscreenCanvas(w, h);
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const img = g.getImageData(0, 0, w, h);
    enhance(img, w, h);
    g.putImageData(img, 0, 0);

    const blob = await cv.convertToBlob({ type: 'image/jpeg', quality });
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
