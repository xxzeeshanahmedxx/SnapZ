/* SnapZ image pipeline — squeeze real quality out of a mediocre phone camera.
   Order matters: denoise → white balance → levels → sharpen → saturation. */

/* ---- 1. multi-frame noise reduction ----------------------------------
   Sensor noise is random; detail is not. Average N frames and the noise
   cancels (~sqrt(N) less) while the face stays put. This is the same trick
   phone "night modes" use, and it's the single best fix for a grainy sensor. */
export function averageFrames(frames, w, h) {
  const out = new Float32Array(w * h * 4);
  for (const f of frames) for (let i = 0; i < out.length; i++) out[i] += f.data[i];
  const img = new ImageData(w, h);
  const n = frames.length;
  for (let i = 0; i < out.length; i++) img.data[i] = out[i] / n;
  return img;
}

/* ---- 2. gray-world white balance -------------------------------------
   Kills the orange cast of indoor bulbs and the blue of overcast days. */
function whiteBalance(d, strength = 0.8) {
  let r = 0, g = 0, b = 0, n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; }
  r /= n; g /= n; b /= n;
  const avg = (r + g + b) / 3;
  const kr = 1 + ((avg / r) - 1) * strength,
        kg = 1 + ((avg / g) - 1) * strength,
        kb = 1 + ((avg / b) - 1) * strength;
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = Math.min(255, d[i]   * kr);
    d[i+1] = Math.min(255, d[i+1] * kg);
    d[i+2] = Math.min(255, d[i+2] * kb);
  }
}

/* ---- 3. auto levels + shadow lift ------------------------------------
   Cheap cameras produce flat, milky images. Stretch the histogram to the
   full range (ignoring the extreme 0.4% so highlights don't blow out),
   then lift shadows with a gamma curve so your face isn't a silhouette. */
function autoLevels(d, clip = 0.004, lift = 1.12) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4)
    hist[(d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) | 0]++;
  const total = d.length / 4, cut = total * clip;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
  if (hi - lo < 24) return;                       // already full range, leave it
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    lut[v] = Math.pow(t, 1 / lift) * 255;
  }
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i+1] = lut[d[i+1]]; d[i+2] = lut[d[i+2]]; }
}

/* ---- 4. unsharp mask --------------------------------------------------
   Soft lens? Subtract a blurred copy to restore apparent detail. Done on
   luminance only, so it sharpens features without amplifying colour noise. */
function unsharp(d, w, h, amount = 0.55, radius = 1) {
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++)
    lum[p] = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
  const blur = new Float32Array(w * h);
  const r = radius;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {       // box blur, separable enough at r=1
    let s = 0, c = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
      s += lum[yy * w + xx]; c++;
    }
    blur[y * w + x] = s / c;
  }
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const diff = (lum[p] - blur[p]) * amount;
    d[i]   = Math.min(255, Math.max(0, d[i]   + diff));
    d[i+1] = Math.min(255, Math.max(0, d[i+1] + diff));
    d[i+2] = Math.min(255, Math.max(0, d[i+2] + diff));
  }
}

/* ---- 5. gentle saturation -------------------------------------------- */
function saturate(d, k = 1.08) {
  for (let i = 0; i < d.length; i += 4) {
    const l = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
    d[i]   = Math.min(255, Math.max(0, l + (d[i]   - l) * k));
    d[i+1] = Math.min(255, Math.max(0, l + (d[i+1] - l) * k));
    d[i+2] = Math.min(255, Math.max(0, l + (d[i+2] - l) * k));
  }
}

export function enhance(imgData, w, h) {
  const d = imgData.data;
  whiteBalance(d);
  autoLevels(d);
  unsharp(d, w, h);
  saturate(d);
  return imgData;
}
