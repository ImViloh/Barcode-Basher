/**
 * Approximate GPU BCn-style quantization on decoded raster (for game/texture-sourced barcodes).
 * Not bit-exact to hardware BC4/BC7 — heuristic re-quantization paths to try for recovery.
 */

function lumaAt(buf: Uint8Array, width: number, channels: number, x: number, y: number): number {
  const p = (y * width + x) * channels;
  const r = buf[p];
  const g = buf[p + 1];
  const b = buf[p + 2];
  return ((r * 306 + g * 601 + b * 117) + 512) >> 10;
}

function setGray(buf: Uint8Array, width: number, channels: number, x: number, y: number, v: number) {
  const p = (y * width + x) * channels;
  const c = Math.max(0, Math.min(255, v | 0));
  buf[p] = c;
  buf[p + 1] = c;
  buf[p + 2] = c;
  if (channels >= 4) buf[p + 3] = 255;
}

/** BC4-like: per 4×4 block, 8 evenly spaced luminance levels between block min/max. */
export function simulateBc4LumaBlocks(rgba: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const out = new Uint8Array(rgba);
  const ch = Math.min(4, Math.max(3, channels));
  for (let by = 0; by < height; by += 4) {
    for (let bx = 0; bx < width; bx += 4) {
      let min = 255;
      let max = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const y = by + dy;
          const x = bx + dx;
          if (y >= height || x >= width) continue;
          const L = lumaAt(out, width, ch, x, y);
          if (L < min) min = L;
          if (L > max) max = L;
        }
      }
      if (max <= min) max = min + 1;
      const span = max - min;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const y = by + dy;
          const x = bx + dx;
          if (y >= height || x >= width) continue;
          const L = lumaAt(out, width, ch, x, y);
          const t = (L - min) / span;
          const idx = Math.min(7, Math.max(0, Math.round(t * 7)));
          const q = Math.round(min + (span * idx) / 7);
          setGray(out, width, ch, x, y, q);
        }
      }
    }
  }
  return out;
}

function rgb565Pack(r: number, g: number, b: number): { r: number; g: number; b: number } {
  const R5 = (r >> 3) & 31;
  const G6 = (g >> 2) & 63;
  const B5 = (b >> 3) & 31;
  const r8 = (R5 << 3) | (R5 >> 2);
  const g8 = (G6 << 2) | (G6 >> 4);
  const b8 = (B5 << 3) | (B5 >> 2);
  return { r: r8, g: g8, b: b8 };
}

/** BC7-ish coarse path: each 4×4 block → average RGB → RGB565 round-trip, fill block. */
export function simulateBc7ishBlockRgb565(rgba: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const out = new Uint8Array(rgba);
  const ch = Math.min(4, Math.max(3, channels));
  for (let by = 0; by < height; by += 4) {
    for (let bx = 0; bx < width; bx += 4) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const y = by + dy;
          const x = bx + dx;
          if (y >= height || x >= width) continue;
          const p = (y * width + x) * ch;
          sr += out[p];
          sg += out[p + 1];
          sb += out[p + 2];
          n++;
        }
      }
      if (n === 0) continue;
      const { r, g, b } = rgb565Pack(Math.round(sr / n), Math.round(sg / n), Math.round(sb / n));
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const y = by + dy;
          const x = bx + dx;
          if (y >= height || x >= width) continue;
          const p = (y * width + x) * ch;
          out[p] = r;
          out[p + 1] = g;
          out[p + 2] = b;
          if (ch >= 4) out[p + 3] = 255;
        }
      }
    }
  }
  return out;
}
