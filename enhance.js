/* SnapZ image pipeline — fast enough to run on a full-resolution phone photo.
   Every pass is O(pixels) with no per-pixel inner loops. */

/* ---- multi-frame noise reduction ----
   Sensor noise is random; detail is not. Averaging N frames cancels the noise
   (~sqrt(N) less) while the face stays put — the trick behind phone night modes. */
export function enhance(imgData, w, h, opt = {}) {
  /* Defaults are tuned for FIDELITY, not flattery: no saturation boost,
     no skin smoothing, no heavy curves. Just noise and dullness. */
  const {
    wbStrength = 0.35,     // gentle cast removal only; 0.8+ starts shifting skin tone
    clip       = 0.002,    // histogram tails ignored when stretching
    lift       = 1.04,     // barely-there shadow lift
    maxStretch = 0.7,      // never apply more than 70% of the full contrast stretch
    sharpen    = 0.3,      // just enough to undo capture softness
    radius     = 1,
    sat        = 1.0,      // OFF — your real colours
    chroma     = 2         // colour-noise denoise radius (0 = off). Luma untouched.
  } = opt;

  const d = imgData.data, px = w * h, len = px * 4;

  /* --- pass 1: statistics, sampled (every 4th pixel is ample) --- */
  const hist = new Uint32Array(256);
  let rs = 0, gs = 0, bs = 0, cnt = 0;
  const step = px > 2e6 ? 16 : 4;
  for (let i = 0; i < len; i += 4 * step) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    rs += r; gs += g; bs += b; cnt++;
    hist[(r * 0.299 + g * 0.587 + b * 0.114) | 0]++;
  }
  const avg = (rs + gs + bs) / (3 * cnt);
  const kr = 1 + ((avg / (rs / cnt)) - 1) * wbStrength;
  const kg = 1 + ((avg / (gs / cnt)) - 1) * wbStrength;
  const kb = 1 + ((avg / (bs / cnt)) - 1) * wbStrength;

  let lo = 0, hi = 255, acc = 0;
  const cut = cnt * clip;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
  const stretch = (hi - lo) > 24;

  /* --- fused LUTs: white balance and levels become one table per channel --- */
  const lutR = new Uint8ClampedArray(256), lutG = new Uint8ClampedArray(256), lutB = new Uint8ClampedArray(256);
  const inv = 1 / lift, span = hi - lo;
  const build = (lut, k) => {
    for (let v = 0; v < 256; v++) {
      const base = Math.min(255, v * k);               // white balance
      let out = base;
      if (stretch) {
        const full = Math.min(255, Math.max(0, ((base - lo) / span) * 255));
        const curved = Math.pow(full / 255, inv) * 255;
        out = base + (curved - base) * maxStretch;     // partial, so it stays natural
      }
      lut[v] = out;
    }
  };
  build(lutR, kr); build(lutG, kg); build(lutB, kb);

  for (let i = 0; i < len; i += 4) {
    d[i] = lutR[d[i]]; d[i + 1] = lutG[d[i + 1]]; d[i + 2] = lutB[d[i + 2]];
  }

  /* --- colour-noise denoise ---
     Sensor noise is mostly chroma: coloured speckles in shadows. Blurring the
     colour channels while leaving luminance completely untouched removes the
     speckle WITHOUT softening a single real detail — no plastic skin. */
  if (chroma > 0) {
    const cb = new Float32Array(px), cr = new Float32Array(px);
    const cbB = new Float32Array(px), crB = new Float32Array(px);
    const y = new Float32Array(px);
    for (let i = 0, p = 0; i < len; i += 4, p++) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      y[p]  =  0.299 * R + 0.587 * G + 0.114 * B;
      cb[p] = B - y[p];
      cr[p] = R - y[p];
    }
    boxBlur(cb, cbB, w, h, chroma);
    boxBlur(cr, crB, w, h, chroma);
    for (let i = 0, p = 0; i < len; i += 4, p++) {
      const Y = y[p], B = Y + cbB[p], R = Y + crB[p];
      d[i]     = R;
      d[i + 2] = B;
      d[i + 1] = (Y - 0.299 * R - 0.114 * B) / 0.587;   // rebuild green from luma
    }
  }

  /* --- unsharp mask on luminance only (no colour-noise amplification) --- */
  if (sharpen > 0) {
    const lum = new Float32Array(px), blur = new Float32Array(px);
    for (let i = 0, p = 0; i < len; i += 4, p++)
      lum[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    boxBlur(lum, blur, w, h, radius);
    for (let i = 0, p = 0; i < len; i += 4, p++) {
      let diff = (lum[p] - blur[p]) * sharpen;
      if (diff > 12) diff = 12; else if (diff < -12) diff = -12;   // no halos / crunch
      if (diff !== 0) {
        d[i]     = d[i]     + diff;
        d[i + 1] = d[i + 1] + diff;
        d[i + 2] = d[i + 2] + diff;
      }
    }
  }

  /* --- saturation --- */
  if (sat !== 1) {
    for (let i = 0; i < len; i += 4) {
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      d[i]     = l + (d[i]     - l) * sat;
      d[i + 1] = l + (d[i + 1] - l) * sat;
      d[i + 2] = l + (d[i + 2] - l) * sat;
    }
  }
  return imgData;
}
