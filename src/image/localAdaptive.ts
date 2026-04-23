/** Sauvola-style local threshold simplified: compare to local mean in a square window. */
export function localAdaptiveLuma(
  luma: Uint8Array,
  width: number,
  height: number,
  windowRadius = 8,
  offset = 12,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const r = windowRadius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += luma[yy * width + xx];
          cnt++;
        }
      }
      const mean = sum / (cnt || 1);
      const pix = luma[y * width + x];
      out[y * width + x] = pix < mean - offset ? 0 : 255;
    }
  }
  return out;
}
