import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { computeOtsuThreshold, histogram256, thresholdBitmap } from '../image/binarize.js';

const defaultFormats = [
  BarcodeFormat.AZTEC,
  BarcodeFormat.CODABAR,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.CODE_128,
  BarcodeFormat.EAN_8,
  BarcodeFormat.EAN_13,
  BarcodeFormat.ITF,
  BarcodeFormat.PDF_417,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.DATA_MATRIX,
];

/** Linear / stacked 1D symbologies only (skips QR, PDF417, Aztec, DataMatrix). */
export const oneDimensionalFormats = [
  BarcodeFormat.CODABAR,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.CODE_128,
  BarcodeFormat.EAN_8,
  BarcodeFormat.EAN_13,
  BarcodeFormat.ITF,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
];

export interface DecodeAttempt {
  text: string;
  format: string;
  binarizer: 'hybrid' | 'global';
  notes: string[];
}

function buildLumaFromRgba(rgba: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const luma = new Uint8Array(width * height);
  if (channels === 1) {
    for (let i = 0; i < width * height; i++) luma[i] = rgba[i];
    return luma;
  }
  if (channels === 2) {
    for (let i = 0, p = 0; i < width * height; i++, p += 2) {
      luma[i] = rgba[p];
    }
    return luma;
  }
  const stride = width * channels;
  const ch = Math.min(4, channels);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const p = row + x * ch;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      luma[y * width + x] = ((r * 306 + g * 601 + b * 117) + 512) >> 10;
    }
  }
  return luma;
}

function invertCopy(lum: Uint8Array): Uint8Array {
  const out = new Uint8Array(lum.length);
  for (let i = 0; i < lum.length; i++) out[i] = 255 - lum[i];
  return out;
}

function buildHints(patch?: Map<DecodeHintType, unknown>): Map<DecodeHintType, unknown> {
  const m = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [...defaultFormats]],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  if (patch) {
    for (const [k, v] of patch) {
      m.set(k, v);
    }
  }
  return m;
}

function tryOnce(
  luminances: Uint8Array,
  width: number,
  height: number,
  binarizer: 'hybrid' | 'global',
  hintPatch?: Map<DecodeHintType, unknown>,
): DecodeAttempt | null {
  const hints = buildHints(hintPatch);
  const clamped = luminances instanceof Uint8ClampedArray ? luminances : Uint8ClampedArray.from(luminances);
  const source = new RGBLuminanceSource(clamped, width, height, width, height, 0, 0);
  const matrix =
    binarizer === 'hybrid' ? new HybridBinarizer(source) : new GlobalHistogramBinarizer(source);
  const bitmap = new BinaryBitmap(matrix);
  const reader = new MultiFormatReader();
  reader.setHints(hints);

  try {
    const result = reader.decode(bitmap);
    return { text: result.getText(), format: String(result.getBarcodeFormat()), binarizer, notes: [binarizer] };
  } catch {
    return null;
  }
}

export function decodeFromLuma(
  luma: Uint8Array,
  width: number,
  height: number,
  hintPatch?: Map<DecodeHintType, unknown>,
): DecodeAttempt[] {
  const outs: DecodeAttempt[] = [];
  for (const bin of ['hybrid', 'global'] as const) {
    for (const inv of [false, true]) {
      const lum = inv ? invertCopy(luma) : luma;
      const hit = tryOnce(lum, width, height, bin, hintPatch);
      if (hit) {
        if (inv) hit.notes.unshift('inverted luminance');
        outs.push(hit);
      }
    }
  }
  return outs;
}

export function decodeFromRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  channels: number,
  hintPatch?: Map<DecodeHintType, unknown>,
): DecodeAttempt[] {
  const luma = buildLumaFromRgba(rgba, width, height, channels);
  return decodeFromLuma(luma, width, height, hintPatch);
}

/**
 * Otsu-threshold the luma plane, expand back to fake RGBA, then run the same ZXing path as {@link decodeFromRgba}.
 * Useful when the raw gradient still hides a clean 1D module pattern.
 */
export function decodeFromRgbaViaOtsuBitmap(
  rgba: Uint8Array,
  width: number,
  height: number,
  channels: number,
  hintPatch?: Map<DecodeHintType, unknown>,
): DecodeAttempt[] {
  const luma = buildLumaFromRgba(rgba, width, height, channels);
  const hist = histogram256(luma);
  const thr = computeOtsuThreshold(hist, luma.length);
  const bits = thresholdBitmap(luma, thr, false);
  const n = width * height;
  const fake = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = bits[i] ? 0 : 255;
    const o = i * 4;
    fake[o] = v;
    fake[o + 1] = v;
    fake[o + 2] = v;
    fake[o + 3] = 255;
  }
  const hits = decodeFromRgba(fake, width, height, 4, hintPatch);
  for (const h of hits) h.notes.unshift(`otsu(T=${thr})`);
  return hits;
}
