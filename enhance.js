/* SnapZ image pipeline — fast enough to run on a full-resolution phone photo.
   Every pass is O(pixels) with no per-pixel inner loops. */

/* ---- multi-frame noise reduction ----
   Sensor noise is random; detail is not. Averaging N frames cancels the noise
   (~sqrt(N) less) while the face stays put — the trick behind phone night modes. */
export function averageFrames(frames, w, h) {
  const n = frames.length, len = w * h * 4;
  const out = new Uint16Array(len);                      // 16-bit is plenty for <=8 frames
  for (const f of frames) { const d = f.data; for (let i = 0; i < len; i++) out[i] += d[i]; }
  const img = new ImageData(w, h);
  const o = img.data;
  for (let i = 0; i < len; i++) o[i] = out[i] / n;
  return img;
}

/* ---- separable sliding-window box blur: O(pixels), independent of radius ---- */
function boxBlur(src, dst, w, h, r) {
  const tmp = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {                          // horizontal
    const row = y * w;
    let sum = src[row] * r;
    for (let x = 0; x <= r; x++) sum += src[row + Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {                          // vertical
    let sum = tmp[x] * r;
    for (let y = 0; y <= r; y++) sum += tmp[Math.min(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / win;
      sum += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
}

/* ---- the whole pipeline in two passes over the pixels ----
   Pass 1 : gather stats (channel means + luma histogram) on a subsample
   Pass 2 : apply white balance + auto levels via a lookup table, then
            unsharp mask on luminance, then saturation — all in one loop. */
export function enhance(imgData, w, h, opt = {}) {
  const {
    wbStrength = 0.8,      // 0 = off, 1 = full gray-world correction
    clip       = 0.004,    // histogram tails ignored when stretching
    lift       = 1.12,     // shadow lift gamma
    sharpen    = 0.55,     // unsharp amount
    radius     = 1,        // unsharp radius
    sat        = 1.08      // saturation
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
      let t = v * k;
      if (stretch) t = Math.min(255, Math.max(0, ((t - lo) / span) * 255));
      lut[v] = stretch ? Math.pow(t / 255, inv) * 255 : Math.min(255, t);
    }
  };
  build(lutR, kr); build(lutG, kg); build(lutB, kb);

  for (let i = 0; i < len; i += 4) {
    d[i] = lutR[d[i]]; d[i + 1] = lutG[d[i + 1]]; d[i + 2] = lutB[d[i + 2]];
  }

  /* --- unsharp mask on luminance only (no colour-noise amplification) --- */
  if (sharpen > 0) {
    const lum = new Float32Array(px), blur = new Float32Array(px);
    for (let i = 0, p = 0; i < len; i += 4, p++)
      lum[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    boxBlur(lum, blur, w, h, radius);
    for (let i = 0, p = 0; i < len; i += 4, p++) {
      const diff = (lum[p] - blur[p]) * sharpen;
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
