import fs from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { DecodeHintType } from '@zxing/library';
import sharp from 'sharp';
import { buildWebEraSieveLines } from '../cipher/webEraSieve.js';
import { containsCrib } from '../crib/scoring.js';
import type { DecodeAttempt } from '../decode/zxingAttempt.js';
import {
  decodeWithJavascriptBarcodeReader,
  decodeWithJavascriptBarcodeReaderDetectRotation,
} from '../decode/jsBarcodeReaderEngine.js';
import { exhaustiveSharpZxingDecode, EXHAUSTIVE_TIMEOUT_MS } from '../decode/exhaustiveSharpZxing.js';
import { decodeWithJsQr } from '../decode/jsQrEngine.js';
import { decodeFromLuma, decodeFromRgba, oneDimensionalFormats } from '../decode/zxingAttempt.js';
import { simulateBc4LumaBlocks, simulateBc7ishBlockRgb565 } from '../image/bcnSimulate.js';
import { computeOtsuThreshold, histogram256, thresholdBitmap } from '../image/binarize.js';
import { localAdaptiveLuma } from '../image/localAdaptive.js';
import { extractPngTextChunks } from '../image/pngTextChunks.js';
import { loadGrayFrame } from '../image/luma.js';
import { binaryRunLengths } from '../image/runlength.js';
import type { StrategyJob, StrategyWorkerFailure, StrategyWorkerResult, StrategyWorkerSuccess } from '../types.js';

const labels: Record<StrategyJob['jobId'], string> = {
  rle_forensics: 'Measure-only · run-length heuristics',
  forensics_png_text: 'PNG · tEXt/zTXt + web-era cipher sieve',
  zxing_native: 'ZXing · native RGBA',
  zxing_otsu_png: 'ZXing · Otsu-hardened bitmap',
  zxing_stretch_2x: 'ZXing · geometric upscale',
  zxing_invert: 'ZXing · color negated source',
  zxing_pad_quiet: 'ZXing · synthetic quiet margins',
  zxing_threshold_sweep: 'ZXing · luminance threshold sweep',
  zxing_exhaustive_chains: 'ZXing · exhaustive Sharp op chains (all orders len≤4) + Otsu raster',
  zxing_sharpen: 'ZXing · sharpen preprocess',
  zxing_normalize: 'ZXing · histogram normalize',
  zxing_flip_h: 'ZXing · horizontal flip',
  zxing_flip_v: 'ZXing · vertical flip (upside-down mirror)',
  zxing_rot180: 'ZXing · rotate 180°',
  zxing_rot90: 'ZXing · rotate 90°',
  zxing_rot270: 'ZXing · rotate 270°',
  zxing_geom_flop_rot90: 'ZXing · flop → rotate 90°',
  zxing_geom_flop_rot270: 'ZXing · flop → rotate 270°',
  zxing_geom_flip_rot90: 'ZXing · flip → rotate 90°',
  zxing_geom_flip_rot270: 'ZXing · flip → rotate 270°',
  zxing_geom_rot90_flop: 'ZXing · rotate 90° → flop',
  zxing_geom_rot90_flip: 'ZXing · rotate 90° → flip',
  zxing_geom_rot180_flop: 'ZXing · rotate 180° → flop',
  zxing_geom_flop_rot180: 'ZXing · flop → rotate 180°',
  zxing_geom_rot270_flop: 'ZXing · rotate 270° → flop',
  zxing_geom_rot270_flip: 'ZXing · rotate 270° → flip',
  zxing_greyscale: 'ZXing · greyscale()',
  zxing_modulate_bright: 'ZXing · modulate brightness↑',
  zxing_modulate_dark: 'ZXing · modulate brightness↓',
  zxing_linear_contrast: 'ZXing · linear contrast stretch',
  zxing_blur_mild: 'ZXing · mild blur denoise',
  zxing_vertical_bands: 'ZXing · upper/mid/lower horizontal crops',
  zxing_pure_barcode: 'ZXing · PURE_BARCODE hint',
  zxing_assume_gs1: 'ZXing · ASSUME_GS1 hint',
  zxing_formats_1d_only: 'ZXing · 1D symbologies only',
  zxing_local_adaptive: 'ZXing · local adaptive threshold',
  bc4_block_quant_luma: 'BC4-style · 4×4 luma block quant + ZXing',
  bc7ish_block_quant_rgb: 'BC7-ish · 4×4 RGB565 block + ZXing',
  zxing_threshold_sweep_crib: 'Crib · threshold sweep until crib in text',
  zxing_crib_gate_bundle: 'Crib · multi-pipeline gate (native/sharp/norm/neg/otsu)',
  engine_jsbarcode_multi: 'JS-Barcode-Reader · multi-symbology sweep',
  engine_jsbarcode_detect_rot: 'JS-Barcode-Reader · detectRotation + locate',
  engine_jsqr: 'jsQR · QR decode (browser-style pipeline, Sharp preprocess)',
};

function success(
  jobId: StrategyJob['jobId'],
  text: string,
  format: string | undefined,
  ms: number,
  notes: string[],
): StrategyWorkerSuccess {
  return { ok: true, jobId, label: labels[jobId], text, format, ms, notes };
}

function failure(jobId: StrategyJob['jobId'], ms: number, error: string, notes: string[]): StrategyWorkerFailure {
  return { ok: false, jobId, label: labels[jobId], ms, error, notes };
}

function pickFirst(hits: DecodeAttempt[]) {
  return hits[0] ?? null;
}

function pickHitWithCrib(hits: DecodeAttempt[], crib: string): DecodeAttempt | null {
  return hits.find((h) => containsCrib(h.text, crib)) ?? null;
}

function bitsToLuma(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = bits[i] ? 0 : 255;
  return out;
}

function gcd(a: number, b: number): number {
  let x = Math.round(a);
  let y = Math.round(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return Math.abs(x) || 1;
}

function getCrib(job: StrategyJob): string {
  return String(job.extra?.crib ?? '').trim();
}

async function runSharpZxing(
  job: StrategyJob,
  noteLine: string,
  pipe: (s: sharp.Sharp) => sharp.Sharp,
  err: string,
): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = [noteLine];
  const { data, info } = await pipe(sharp(job.imagePath!)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, err, notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runNative(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const { data, info } = await sharp(job.imagePath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No symbology matched', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runOtsu(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const { width, height, luma } = await loadGrayFrame(job.imagePath!);
  const hist = histogram256(luma);
  const thr = computeOtsuThreshold(hist, luma.length);
  notes.push(`Otsu T=${thr}`);
  const bits = thresholdBitmap(luma, thr, false);
  const hit = pickFirst(decodeFromLuma(bitsToLuma(bits), width, height));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode on Otsu binarization', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runStretch(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const meta = await sharp(job.imagePath!).metadata();
  const w0 = meta.width ?? 1;
  const h0 = meta.height ?? 1;
  const targetW = Math.min(16_000, Math.round(w0 * 2));
  const targetH = Math.max(120, Math.min(400, Math.round(h0 * 8)));
  const { data, info } = await sharp(job.imagePath!)
    .resize({ width: targetW, height: targetH, fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  notes.push(`Warped to ${info.width}×${info.height}px`);
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after upscale', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runPadQuiet(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const meta = await sharp(job.imagePath!).metadata();
  const w0 = meta.width ?? 1;
  const pad = Math.max(48, Math.round(w0 * 0.12));
  notes.push(`Added L/R padding ${pad}px on ${w0}px canvas`);
  const { data, info } = await sharp(job.imagePath!)
    .extend({
      left: pad,
      right: pad,
      top: Math.max(8, Math.round((meta.height ?? 1) * 0.25)),
      bottom: Math.max(8, Math.round((meta.height ?? 1) * 0.25)),
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after padding', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runNegate(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const { data, info } = await sharp(job.imagePath!)
    .negate({ alpha: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  notes.push('Sharp negate() on RGB channels');
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode on negated raster', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runThresholdSweep(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const { width, height, luma } = await loadGrayFrame(job.imagePath!);
  const thresholds = [32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224];
  for (const thr of thresholds) {
    for (const inv of [false, true]) {
      const bits = thresholdBitmap(luma, thr, inv);
      const hit = pickFirst(decodeFromLuma(bitsToLuma(bits), width, height));
      if (hit) {
        const ms = performance.now() - t0;
        notes.push(`Hit at T=${thr} invert=${inv}`, ...hit.notes);
        return success(job.jobId, hit.text, hit.format, ms, notes);
      }
    }
  }
  const ms = performance.now() - t0;
  return failure(job.jobId, ms, 'Sweep exhausted with no decode', notes);
}

async function runThresholdSweepCrib(job: StrategyJob): Promise<StrategyWorkerResult> {
  const crib = getCrib(job);
  const t0 = performance.now();
  const notes: string[] = [];
  if (!crib) return failure(job.jobId, 0, 'No crib supplied (use --crib or default)', notes);
  notes.push(`crib="${crib}"`);
  const { width, height, luma } = await loadGrayFrame(job.imagePath!);
  const thresholds = [24, 40, 56, 72, 88, 104, 120, 136, 152, 168, 184, 200, 216, 232];
  for (const thr of thresholds) {
    for (const inv of [false, true]) {
      const bits = thresholdBitmap(luma, thr, inv);
      const hits = decodeFromLuma(bitsToLuma(bits), width, height);
      const hit = pickHitWithCrib(hits, crib);
      if (hit) {
        const ms = performance.now() - t0;
        notes.push(`Crib hit at T=${thr} invert=${inv}`, ...hit.notes);
        return success(job.jobId, hit.text, hit.format, ms, notes);
      }
    }
  }
  const ms = performance.now() - t0;
  return failure(job.jobId, ms, 'No threshold produced a decode containing the crib', notes);
}

async function runCribGateBundle(job: StrategyJob): Promise<StrategyWorkerResult> {
  const crib = getCrib(job);
  const t0 = performance.now();
  const notes: string[] = [];
  if (!crib) return failure(job.jobId, 0, 'No crib supplied', notes);
  notes.push(`crib="${crib}"`);

  const p = job.imagePath!;
  type Pipe = { name: string; buf: Buffer; w: number; h: number; ch: number };
  const pipes: Pipe[] = [];

  {
    const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pipes.push({ name: 'native', buf: data, w: info.width, h: info.height, ch: info.channels });
  }
  {
    const { data, info } = await sharp(p).sharpen({ sigma: 1.1, m1: 1, m2: 0.3 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pipes.push({ name: 'sharpen', buf: data, w: info.width, h: info.height, ch: info.channels });
  }
  {
    const { data, info } = await sharp(p).normalize().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pipes.push({ name: 'normalize', buf: data, w: info.width, h: info.height, ch: info.channels });
  }
  {
    const { data, info } = await sharp(p).negate({ alpha: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pipes.push({ name: 'negate', buf: data, w: info.width, h: info.height, ch: info.channels });
  }
  {
    const { data, info } = await sharp(p).grayscale().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pipes.push({ name: 'greyscale', buf: data, w: info.width, h: info.height, ch: info.channels });
  }

  const { width, height, luma } = await loadGrayFrame(p);
  const hist = histogram256(luma);
  const thr = computeOtsuThreshold(hist, luma.length);
  const bits = thresholdBitmap(luma, thr, false);
  const fake = bitsToLuma(bits);
  const otsuHits = decodeFromLuma(fake, width, height);
  const otsuCrib = pickHitWithCrib(otsuHits, crib);
  if (otsuCrib) {
    const ms = performance.now() - t0;
    notes.push(`matched via pipeline: otsu(T=${thr})`, ...otsuCrib.notes);
    return success(job.jobId, otsuCrib.text, otsuCrib.format, ms, notes);
  }

  for (const pipe of pipes) {
    const hits = decodeFromRgba(pipe.buf, pipe.w, pipe.h, pipe.ch);
    const hit = pickHitWithCrib(hits, crib);
    if (hit) {
      const ms = performance.now() - t0;
      notes.push(`matched via pipeline: ${pipe.name}`, ...hit.notes);
      return success(job.jobId, hit.text, hit.format, ms, notes);
    }
  }

  const ms = performance.now() - t0;
  return failure(job.jobId, ms, 'No pipeline produced a decode containing the crib', notes);
}

async function runRle(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const { width, height, luma } = await loadGrayFrame(job.imagePath!);
  const hist = histogram256(luma);
  const thr = computeOtsuThreshold(hist, luma.length);
  const bits = thresholdBitmap(luma, thr, false);
  const row = height >> 1;
  const rowBits = new Uint8Array(width);
  for (let x = 0; x < width; x++) rowBits[x] = bits[row * width + x];
  const runs = binaryRunLengths(rowBits, 1);
  const widths = runs.filter((_, i) => i % 2 === 0);
  const barMin = widths.length ? Math.min(...widths) : 0;
  const barMax = widths.length ? Math.max(...widths) : 0;
  let g = widths[0] ?? 1;
  for (const w of widths.slice(0, 400)) g = gcd(g, w);
  notes.push(`Run count ${runs.length}`);
  notes.push(`Bar width px min/max: ${barMin}/${barMax}`);
  notes.push(`GCD probe on bar runs: ${g}px`);
  notes.push(`First run (quiet/white guess): ${runs[0] ?? 0}px`);

  const summary = `RLE · runs=${runs.length} · barMin=${barMin} · barMax=${barMax} · gcd~${g}px · otsu=${thr}`;
  const ms = performance.now() - t0;
  return success(job.jobId, summary, 'FORENSICS', ms, notes);
}

async function runExhaustiveChains(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const crib = getCrib(job);
  const ex = await exhaustiveSharpZxingDecode(job.imagePath!, crib);
  const ms = performance.now() - t0;
  if (!ex.ok) {
    return failure(job.jobId, ms, 'Exhaustive Sharp chain sweep: no ZXing decode', [
      `sharp_chains_rendered=${ex.chainsTried}`,
      ex.timedOut ? `wall_clock>${EXHAUSTIVE_TIMEOUT_MS}ms (partial)` : 'search space complete for depth cap',
    ]);
  }
  const st = ex.stats;
  return success(job.jobId, st.primaryText, st.primaryFormat, ms, st.notes);
}

async function runPngTextForensics(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = ['PNG tEXt / zTXt + web-era sieve (ROT13, atbash, Base64/hex, MD5)'];
  const buf = await fs.readFile(job.imagePath!);
  const chunks = extractPngTextChunks(new Uint8Array(buf));
  if (!chunks.length) {
    const ms = performance.now() - t0;
    notes.push('(no tEXt/zTXt, or file is not a PNG)');
    return success(job.jobId, 'PNG embedded text: none', 'FORENSICS', ms, notes);
  }

  const parts: string[] = [];
  for (const c of chunks.slice(0, 14)) {
    const pv = c.text.length > 160 ? `${c.text.slice(0, 160)}…` : c.text;
    parts.push(`${c.type}:${c.keyword}=${pv}`);
    const sieve = buildWebEraSieveLines(`png:${c.keyword}`, c.text, {
      maxLines: 16,
      crib: getCrib(job) || undefined,
    });
    for (const line of sieve) {
      notes.push(`${c.keyword}> ${line}`);
      if (notes.length > 110) {
        notes.push('… (notes truncated)');
        break;
      }
    }
    if (notes.length > 110) break;
  }
  const summary = `PNG text chunks: ${chunks.length} · ${parts.slice(0, 3).join(' · ')}`;
  const ms = performance.now() - t0;
  return success(job.jobId, summary, 'FORENSICS', ms, notes);
}

async function runSharpen(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['sharp.sharpen()'];
  const { data, info } = await sharp(job.imagePath!)
    .sharpen({ sigma: 1.15, m1: 1, m2: 0.35 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after sharpen', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runNormalize(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['sharp.normalize()'];
  const { data, info } = await sharp(job.imagePath!).normalize().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after normalize', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runFlipH(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['sharp.flop()'];
  const { data, info } = await sharp(job.imagePath!).flop().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after horizontal flip', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runRot180(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['sharp.rotate(180)'];
  const { data, info } = await sharp(job.imagePath!).rotate(180).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after 180° rotation', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runRot90(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['sharp.rotate(90)'];
  const { data, info } = await sharp(job.imagePath!).rotate(90).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after 90° rotation', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runRot270(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['sharp.rotate(270)'];
  const { data, info } = await sharp(job.imagePath!).rotate(270).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after 270° rotation', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runGreyscale(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['sharp.grayscale()'];
  const { data, info } = await sharp(job.imagePath!).grayscale().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after greyscale', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runModulateBright(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['modulate brightness 1.28'];
  const { data, info } = await sharp(job.imagePath!)
    .modulate({ brightness: 1.28, saturation: 0.92 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after bright modulate', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runModulateDark(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['modulate brightness 0.82'];
  const { data, info } = await sharp(job.imagePath!)
    .modulate({ brightness: 0.82, saturation: 0.95 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after dark modulate', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runLinearContrast(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['linear(1.38, -42)'];
  const { data, info } = await sharp(job.imagePath!)
    .linear(1.38, -42)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after linear contrast', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runBlurMild(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['blur sigma 0.7'];
  const { data, info } = await sharp(job.imagePath!).blur(0.7).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after blur', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runVerticalBands(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = [];
  const meta = await sharp(job.imagePath!).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const bands = [
    { top: 0, height: Math.max(8, Math.floor(H * 0.35)), name: 'upper 35%' },
    { top: Math.floor(H * 0.32), height: Math.max(8, Math.floor(H * 0.36)), name: 'middle 36%' },
    { top: Math.floor(H * 0.65), height: Math.max(8, H - Math.floor(H * 0.65)), name: 'lower tail' },
  ];
  for (const b of bands) {
    const { data, info } = await sharp(job.imagePath!)
      .extract({ left: 0, top: b.top, width: W, height: b.height })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels));
    if (hit) {
      const ms = performance.now() - t0;
      notes.push(`band: ${b.name}`, ...hit.notes);
      return success(job.jobId, hit.text, hit.format, ms, notes);
    }
  }
  const ms = performance.now() - t0;
  return failure(job.jobId, ms, 'No decode on upper/mid/lower crops', notes);
}

async function runPureBarcode(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['DecodeHintType.PURE_BARCODE'];
  const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.PURE_BARCODE, true]]);
  const { data, info } = await sharp(job.imagePath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels, hints));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode with PURE_BARCODE', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runAssumeGs1(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['DecodeHintType.ASSUME_GS1'];
  const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.ASSUME_GS1, true]]);
  const { data, info } = await sharp(job.imagePath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels, hints));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode with ASSUME_GS1', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runFormats1dOnly(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['POSSIBLE_FORMATS = linear 1D set'];
  const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [...oneDimensionalFormats]]]);
  const { data, info } = await sharp(job.imagePath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hit = pickFirst(decodeFromRgba(data, info.width, info.height, info.channels, hints));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode with 1D-only format list', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runLocalAdaptive(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['local window mean threshold (r=8, offset=12)'];
  const { width, height, luma } = await loadGrayFrame(job.imagePath!);
  const binLuma = localAdaptiveLuma(luma, width, height, 8, 12);
  const hit = pickFirst(decodeFromLuma(binLuma, width, height));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode on local adaptive binarization', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runBc4(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['Simulated BC4: 4×4 block, 8 luma levels between block min/max'];
  const { data, info } = await sharp(job.imagePath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const buf = new Uint8Array(data);
  const transformed = simulateBc4LumaBlocks(buf, info.width, info.height, info.channels);
  const hit = pickFirst(decodeFromRgba(transformed, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after BC4-style pass', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runJsBarcodeMulti(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = ['engine: javascript-barcode-reader (non-ZXing)'];
  const hits = await decodeWithJavascriptBarcodeReader(job.imagePath!);
  const ms = performance.now() - t0;
  if (!hits.length) {
    return failure(job.jobId, ms, 'No decode (javascript-barcode-reader)', notes);
  }
  const first = hits[0];
  notes.push(
    `primary: ${first.barcode}${first.barcodeType ? `/${first.barcodeType}` : ''} · ${first.optLabel}`,
  );
  for (const h of hits.slice(1, 8)) {
    notes.push(
      `alt: [${h.barcode}${h.barcodeType ? '/' + h.barcodeType : ''}] ${h.text.slice(0, 56)}${h.text.length > 56 ? '…' : ''}`,
    );
  }
  if (hits.length > 8) notes.push(`… ${hits.length - 8} more variant(s)`);
  return success(job.jobId, first.text, `JSBC/${first.barcode}`, ms, notes);
}

async function runJsBarcodeDetectRot(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = ['engine: javascript-barcode-reader · detectRotation'];
  const hits = await decodeWithJavascriptBarcodeReaderDetectRotation(job.imagePath!);
  const ms = performance.now() - t0;
  if (!hits.length) {
    return failure(job.jobId, ms, 'No decode (javascript-barcode-reader + detectRotation)', notes);
  }
  const first = hits[0];
  notes.push(
    `primary: ${first.barcode}${first.barcodeType ? `/${first.barcodeType}` : ''} · ${first.optLabel}`,
  );
  for (const h of hits.slice(1, 8)) {
    notes.push(
      `alt: [${h.barcode}${h.barcodeType ? '/' + h.barcodeType : ''}] ${h.text.slice(0, 56)}${h.text.length > 56 ? '…' : ''}`,
    );
  }
  if (hits.length > 8) notes.push(`… ${hits.length - 8} more variant(s)`);
  return success(job.jobId, first.text, `JSBC/${first.barcode}`, ms, notes);
}

async function runJsQr(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes: string[] = ['engine: jsQR (QR only; common web-era reader)'];
  const hits = await decodeWithJsQr(job.imagePath!);
  const ms = performance.now() - t0;
  if (!hits.length) {
    return failure(job.jobId, ms, 'No QR decode (jsQR)', notes);
  }
  const first = hits[0];
  notes.push(`primary: ${first.note}`);
  for (const h of hits.slice(1, 10)) {
    notes.push(`alt: ${h.text.slice(0, 72)}${h.text.length > 72 ? '…' : ''} · ${h.note}`);
  }
  if (hits.length > 10) notes.push(`… ${hits.length - 10} more orientation(s)`);
  return success(job.jobId, first.text, 'QR_JSQR', ms, notes);
}

async function runBc7ish(job: StrategyJob): Promise<StrategyWorkerResult> {
  const t0 = performance.now();
  const notes = ['Simulated BC7-ish: 4×4 block → mean RGB → RGB565 round-trip'];
  const { data, info } = await sharp(job.imagePath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const buf = new Uint8Array(data);
  const transformed = simulateBc7ishBlockRgb565(buf, info.width, info.height, info.channels);
  const hit = pickFirst(decodeFromRgba(transformed, info.width, info.height, info.channels));
  const ms = performance.now() - t0;
  if (!hit) return failure(job.jobId, ms, 'No decode after BC7-ish pass', notes);
  notes.push(...hit.notes);
  return success(job.jobId, hit.text, hit.format, ms, notes);
}

async function runJob(job: StrategyJob): Promise<StrategyWorkerResult> {
  if (!job.imagePath) return failure(job.jobId, 0, 'Missing imagePath', []);
  switch (job.jobId) {
    case 'rle_forensics':
      return runRle(job);
    case 'forensics_png_text':
      return runPngTextForensics(job);
    case 'zxing_native':
      return runNative(job);
    case 'zxing_otsu_png':
      return runOtsu(job);
    case 'zxing_stretch_2x':
      return runStretch(job);
    case 'zxing_invert':
      return runNegate(job);
    case 'zxing_pad_quiet':
      return runPadQuiet(job);
    case 'zxing_threshold_sweep':
      return runThresholdSweep(job);
    case 'zxing_exhaustive_chains':
      return runExhaustiveChains(job);
    case 'zxing_threshold_sweep_crib':
      return runThresholdSweepCrib(job);
    case 'zxing_crib_gate_bundle':
      return runCribGateBundle(job);
    case 'zxing_sharpen':
      return runSharpen(job);
    case 'zxing_normalize':
      return runNormalize(job);
    case 'zxing_flip_h':
      return runFlipH(job);
    case 'zxing_flip_v':
      return runSharpZxing(job, 'sharp.flip()', (s) => s.flip(), 'No decode after vertical flip');
    case 'zxing_rot180':
      return runRot180(job);
    case 'zxing_rot90':
      return runRot90(job);
    case 'zxing_rot270':
      return runRot270(job);
    case 'zxing_geom_flop_rot90':
      return runSharpZxing(job, 'flop → rotate(90)', (s) => s.flop().rotate(90), 'No decode after flop→90°');
    case 'zxing_geom_flop_rot270':
      return runSharpZxing(job, 'flop → rotate(270)', (s) => s.flop().rotate(270), 'No decode after flop→270°');
    case 'zxing_geom_flip_rot90':
      return runSharpZxing(job, 'flip → rotate(90)', (s) => s.flip().rotate(90), 'No decode after flip→90°');
    case 'zxing_geom_flip_rot270':
      return runSharpZxing(job, 'flip → rotate(270)', (s) => s.flip().rotate(270), 'No decode after flip→270°');
    case 'zxing_geom_rot90_flop':
      return runSharpZxing(job, 'rotate(90) → flop', (s) => s.rotate(90).flop(), 'No decode after 90°→flop');
    case 'zxing_geom_rot90_flip':
      return runSharpZxing(job, 'rotate(90) → flip', (s) => s.rotate(90).flip(), 'No decode after 90°→flip');
    case 'zxing_geom_rot180_flop':
      return runSharpZxing(job, 'rotate(180) → flop', (s) => s.rotate(180).flop(), 'No decode after 180°→flop');
    case 'zxing_geom_flop_rot180':
      return runSharpZxing(job, 'flop → rotate(180)', (s) => s.flop().rotate(180), 'No decode after flop→180°');
    case 'zxing_geom_rot270_flop':
      return runSharpZxing(job, 'rotate(270) → flop', (s) => s.rotate(270).flop(), 'No decode after 270°→flop');
    case 'zxing_geom_rot270_flip':
      return runSharpZxing(job, 'rotate(270) → flip', (s) => s.rotate(270).flip(), 'No decode after 270°→flip');
    case 'zxing_greyscale':
      return runGreyscale(job);
    case 'zxing_modulate_bright':
      return runModulateBright(job);
    case 'zxing_modulate_dark':
      return runModulateDark(job);
    case 'zxing_linear_contrast':
      return runLinearContrast(job);
    case 'zxing_blur_mild':
      return runBlurMild(job);
    case 'zxing_vertical_bands':
      return runVerticalBands(job);
    case 'zxing_pure_barcode':
      return runPureBarcode(job);
    case 'zxing_assume_gs1':
      return runAssumeGs1(job);
    case 'zxing_formats_1d_only':
      return runFormats1dOnly(job);
    case 'zxing_local_adaptive':
      return runLocalAdaptive(job);
    case 'bc4_block_quant_luma':
      return runBc4(job);
    case 'bc7ish_block_quant_rgb':
      return runBc7ish(job);
    case 'engine_jsbarcode_multi':
      return runJsBarcodeMulti(job);
    case 'engine_jsbarcode_detect_rot':
      return runJsBarcodeDetectRot(job);
    case 'engine_jsqr':
      return runJsQr(job);
    default:
      return failure(job.jobId, 0, 'Unknown job', []);
  }
}

async function main() {
  const job = workerData as StrategyJob;
  const result = await runJob(job);
  parentPort?.postMessage(result);
}

void main();
