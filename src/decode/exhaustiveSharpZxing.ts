import sharp from 'sharp';
import { containsCrib } from '../crib/scoring.js';
import type { DecodeAttempt } from './zxingAttempt.js';
import { decodeFromRgba, decodeFromRgbaViaOtsuBitmap } from './zxingAttempt.js';

/**
 * Max composition length (with repetition): every ordered tuple of atoms with length 1…DEPTH.
 * Runs **sequentially** after the parallel worker batch (see `index.ts`) so 14⁴ Sharp renders stay on one core budget.
 */
export const EXHAUSTIVE_MAX_DEPTH = 4;
/** Wall-clock cap so a run cannot hang forever. */
export const EXHAUSTIVE_TIMEOUT_MS = 240_000;

type Atomic = { id: string; apply: (s: sharp.Sharp) => sharp.Sharp };

/**
 * Ordered Sharp ops chained left-to-right (same semantics as existing strategy workers).
 * Includes identity so chains can selectively skip tonal or geo steps.
 */
export const SHARP_ATOMICS: readonly Atomic[] = [
  { id: 'id', apply: (s) => s },
  { id: 'grey', apply: (s) => s.grayscale() },
  { id: 'neg', apply: (s) => s.negate({ alpha: false }) },
  { id: 'flop', apply: (s) => s.flop() },
  { id: 'flip', apply: (s) => s.flip() },
  { id: 'r90', apply: (s) => s.rotate(90) },
  { id: 'r180', apply: (s) => s.rotate(180) },
  { id: 'r270', apply: (s) => s.rotate(270) },
  { id: 'norm', apply: (s) => s.normalize() },
  { id: 'sharp', apply: (s) => s.sharpen({ sigma: 1.12, m1: 1, m2: 0.32 }) },
  { id: 'blur', apply: (s) => s.blur(0.65) },
  { id: 'lin', apply: (s) => s.linear(1.38, -40) },
  { id: 'bright', apply: (s) => s.modulate({ brightness: 1.24, saturation: 0.94 }) },
  { id: 'dark', apply: (s) => s.modulate({ brightness: 0.83, saturation: 0.94 }) },
];

function chainLabel(idxs: readonly number[]): string {
  return idxs.map((i) => SHARP_ATOMICS[i]!.id).join('→');
}

export interface ExhaustiveDecodeStats {
  primaryText: string;
  primaryFormat: string;
  notes: string[];
  chainsTried: number;
  uniqueCount: number;
  timedOut: boolean;
}

export type ExhaustiveSharpResult =
  | { ok: true; stats: ExhaustiveDecodeStats }
  | { ok: false; chainsTried: number; timedOut: boolean };

function recordHit(
  byText: Map<string, { formats: Set<string>; chains: string[] }>,
  hit: DecodeAttempt,
  chainStr: string,
  route: string,
): void {
  const ent = byText.get(hit.text) ?? { formats: new Set<string>(), chains: [] };
  ent.formats.add(hit.format);
  const note = `${route}·${chainStr}|${hit.notes.join(' ')}`;
  if (ent.chains.length < 10) ent.chains.push(note);
  byText.set(hit.text, ent);
}

/**
 * Try every composition of {@link SHARP_ATOMICS} of lengths 1…{@link EXHAUSTIVE_MAX_DEPTH} (with repetition),
 * then ZXing on raw RGBA plus Otsu-fake-RGBA for each raster.
 */
export async function exhaustiveSharpZxingDecode(imagePath: string, crib: string): Promise<ExhaustiveSharpResult> {
  const n = SHARP_ATOMICS.length;
  const t0 = performance.now();
  const byText = new Map<string, { formats: Set<string>; chains: string[] }>();
  let chainsTried = 0;
  let timedOut = false;

  outer: for (let depth = 1; depth <= EXHAUSTIVE_MAX_DEPTH; depth++) {
    const total = n ** depth;
    for (let code = 0; code < total; code++) {
      if (performance.now() - t0 > EXHAUSTIVE_TIMEOUT_MS) {
        timedOut = true;
        break outer;
      }
      const idxs = new Array<number>(depth);
      let x = code;
      for (let d = 0; d < depth; d++) {
        idxs[d] = x % n;
        x = Math.floor(x / n);
      }
      const label = chainLabel(idxs);
      let pipe = sharp(imagePath);
      try {
        for (const i of idxs) pipe = SHARP_ATOMICS[i]!.apply(pipe);
        const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const buf = new Uint8Array(data);
        chainsTried++;
        const w = info.width;
        const h = info.height;
        const ch = info.channels;
        for (const hit of decodeFromRgba(buf, w, h, ch)) recordHit(byText, hit, label, 'rgba');
        for (const hit of decodeFromRgbaViaOtsuBitmap(buf, w, h, ch)) recordHit(byText, hit, label, 'otsu');
      } catch {
        /* degenerate pipeline; skip */
      }
    }
  }

  if (byText.size === 0) {
    return { ok: false, chainsTried, timedOut };
  }

  const cribTrim = crib.trim();
  const entries = [...byText.entries()];
  let pick = entries.reduce((a, b) => (a[0].length >= b[0].length ? a : b));
  if (cribTrim) {
    const withCrib = entries.filter(([tx]) => containsCrib(tx, cribTrim));
    if (withCrib.length) {
      withCrib.sort((a, b) => b[0].length - a[0].length);
      pick = withCrib[0]!;
    }
  }

  const [primaryText, meta] = pick;
  const primaryFormat = [...meta.formats].join('|');

  const notes: string[] = [
    `exhaustive Sharp→ZXing · depth≤${EXHAUSTIVE_MAX_DEPTH} · |atoms|=${n} · sharp_chains=${chainsTried}`,
    timedOut ? `stopped: wall>${EXHAUSTIVE_TIMEOUT_MS}ms (partial)` : 'finished within wall clock',
    `unique payloads=${byText.size}`,
    `primary rule: ${cribTrim && containsCrib(primaryText, cribTrim) ? 'longest among crib hits' : 'longest payload'}`,
    `example chain(s) for primary: ${meta.chains.slice(0, 4).join(' || ')}`,
  ];

  const extras = entries
    .filter(([tx]) => tx !== primaryText)
    .sort((a, b) => b[0].length - a[0].length)
    .slice(0, 28);
  for (const [tx, m] of extras) {
    const prev = tx.length > 96 ? `${tx.slice(0, 96)}…` : tx;
    notes.push(`alt len=${tx.length}: ${prev} · fmt=${[...m.formats].join(',')}`);
    for (const c of m.chains.slice(0, 1)) notes.push(`  via ${c}`);
  }

  return {
    ok: true,
    stats: {
      primaryText,
      primaryFormat,
      notes,
      chainsTried,
      uniqueCount: byText.size,
      timedOut,
    },
  };
}
