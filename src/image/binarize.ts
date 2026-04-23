/** Otsu's method on 8-bit luminance histogram. */
export function computeOtsuThreshold(hist256: Uint32Array, totalPixels: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist256[i];
  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let maxVar = 0;
  let threshold = 0;

  for (let t = 0; t < 256; t++) {
    wB += hist256[t];
    if (wB === 0) continue;
    wF = totalPixels - wB;
    if (wF === 0) break;
    sumB += t * hist256[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between >= maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

export function histogram256(luma: Uint8Array): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0; i < luma.length; i++) h[luma[i]]++;
  return h;
}

export function thresholdBitmap(luma: Uint8Array, t: number, invert: boolean): Uint8Array {
  const out = new Uint8Array(luma.length);
  for (let i = 0; i < luma.length; i++) {
    const bit = luma[i] < t ? 1 : 0;
    out[i] = invert ? (1 - bit) as 0 | 1 : (bit as 0 | 1);
  }
  return out;
}
