import { computeOtsuThreshold, histogram256, thresholdBitmap } from './image/binarize.js';
import { bitsToBinaryString, hashFileBytes, hexDump, md5Hex, sha256Hex, shannonEntropy } from './digest/signalDigest.js';
import { columnMeanProjection, loadAnalysisFrame } from './image/luma.js';
import { binaryRunLengths, estimateQuietZones } from './image/runlength.js';
import type { FileChecksums, ImageForensics } from './types.js';

function meanMinMax(luma: Uint8Array): { mean: number; min: number; max: number } {
  let sum = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < luma.length; i++) {
    const v = luma[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { mean: sum / luma.length, min, max };
}

function downsample(arr: Float64Array, maxPoints: number): number[] {
  if (arr.length <= maxPoints) return Array.from(arr, (v) => v / 255);
  const step = arr.length / maxPoints;
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(arr.length - 1, Math.floor(i * step));
    out.push(arr[idx] / 255);
  }
  return out;
}

export async function buildForensics(imagePath: string): Promise<ImageForensics> {
  const [{ size: fileSize, md5: fileMd5, sha256: fileSha256 }, frame] = await Promise.all([
    hashFileBytes(imagePath),
    loadAnalysisFrame(imagePath),
  ]);

  const { width, height, channels, rgba, luma } = frame;
  const rawPixelMd5 = md5Hex(rgba);
  const rawPixelSha256 = sha256Hex(rgba);
  const checksums: FileChecksums = {
    fileSize,
    fileMd5,
    fileSha256,
    rawPixelBytes: rgba.length,
    rawPixelMd5,
    rawPixelSha256,
  };

  const row = height >> 1;
  const rowStride = width * channels;
  const rowStart = row * rowStride;
  const hexBytes = Math.min(96, rowStride);
  const rowSlice = rgba.subarray(rowStart, rowStart + hexBytes);
  const hexCenterRowRgba = hexDump(rowSlice, hexBytes);

  const { mean, min, max } = meanMinMax(luma);
  const hist = histogram256(luma);
  const otsuThreshold = computeOtsuThreshold(hist, luma.length);
  const entropyLumaGlobal = shannonEntropy(luma);
  const entropyCenterRowRgba = shannonEntropy(rowSlice);

  const proj = columnMeanProjection(luma, width, height);
  const projHist = new Uint32Array(256);
  for (let i = 0; i < proj.length; i++) {
    const b = Math.max(0, Math.min(255, Math.round(proj[i])));
    projHist[b]++;
  }
  const projOtsu = computeOtsuThreshold(projHist, proj.length);
  const qz = estimateQuietZones(proj, projOtsu);

  const bits = thresholdBitmap(luma, otsuThreshold, false);
  const rowBits = new Uint8Array(width);
  for (let x = 0; x < width; x++) rowBits[x] = bits[row * width + x];
  const runs = binaryRunLengths(rowBits, 1);
  const moduleRunPreview = runs.slice(0, 64);
  const binaryScanlineOtsu = bitsToBinaryString(rowBits, 768);

  return {
    path: imagePath,
    width,
    height,
    channels,
    meanLuma: mean,
    minLuma: min,
    maxLuma: max,
    otsuThreshold,
    projectionSample: downsample(proj, 96),
    moduleRunPreview,
    quietZoneEstimatePx: qz,
    checksums,
    hexCenterRowRgba,
    binaryScanlineOtsu,
    entropyLumaGlobal,
    entropyCenterRowRgba,
  };
}
