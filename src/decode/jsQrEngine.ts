import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
// jsQR ships a webpack bundle as main; default import is not always callable under NodeNext ESM.
const jsQR = require('jsqr') as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: { inversionAttempts?: string },
) => { data: string } | null;

export interface JsQrHit {
  text: string;
  note: string;
}

function rgbaFromSharp(data: Buffer, width: number, height: number, channels: number): Uint8ClampedArray {
  const px = width * height;
  const out = new Uint8ClampedArray(px * 4);
  if (channels === 4) {
    out.set(data);
    return out;
  }
  if (channels === 3) {
    let j = 0;
    for (let i = 0; i < px; i++) {
      out[j++] = data[i * 3];
      out[j++] = data[i * 3 + 1];
      out[j++] = data[i * 3 + 2];
      out[j++] = 255;
    }
    return out;
  }
  if (channels === 2) {
    let j = 0;
    for (let i = 0; i < px; i++) {
      const g = data[i * 2];
      out[j++] = g;
      out[j++] = g;
      out[j++] = g;
      out[j++] = data[i * 2 + 1];
    }
    return out;
  }
  /* greyscale or single channel */
  let j = 0;
  for (let i = 0; i < px; i++) {
    const g = data[i];
    out[j++] = g;
    out[j++] = g;
    out[j++] = g;
    out[j++] = 255;
  }
  return out;
}

/**
 * jsQR — pure JS QR reader (common in browser tooling / web ARG stacks), independent of ZXing.
 */
export async function decodeWithJsQr(imagePath: string): Promise<JsQrHit[]> {
  const hits: JsQrHit[] = [];
  const seen = new Set<string>();

  const pipelines: { note: string; pipe: (s: sharp.Sharp) => sharp.Sharp }[] = [
    { note: 'rgba native', pipe: (s) => s.ensureAlpha() },
    { note: 'greyscale', pipe: (s) => s.grayscale().ensureAlpha() },
    { note: 'negate', pipe: (s) => s.negate({ alpha: false }).ensureAlpha() },
    { note: 'rotate 180°', pipe: (s) => s.rotate(180).ensureAlpha() },
    { note: 'rotate 90°', pipe: (s) => s.rotate(90).ensureAlpha() },
    { note: 'flop', pipe: (s) => s.flop().ensureAlpha() },
    { note: 'flip', pipe: (s) => s.flip().ensureAlpha() },
  ];

  for (const { note, pipe } of pipelines) {
    const { data, info } = await pipe(sharp(imagePath)).raw().toBuffer({ resolveWithObject: true });
    const rgba = rgbaFromSharp(data, info.width, info.height, info.channels);
    const r = jsQR(rgba, info.width, info.height, { inversionAttempts: 'attemptBoth' });
    const text = r?.data?.trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    hits.push({ text, note: `${note} · inversionAttempts=attemptBoth` });
  }

  return hits;
}
