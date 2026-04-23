import type { StrategyWorkerResult } from '../types.js';

/** Normalize for loose matching (barcode text often lacks spaces/punctuation). */
export function normalizeForCrib(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function containsCrib(decoded: string, crib: string): boolean {
  const c = crib.trim();
  if (!c) return false;
  const d = decoded.toLowerCase();
  const plain = c.toLowerCase();
  if (d.includes(plain)) return true;
  const dn = normalizeForCrib(decoded);
  const cn = normalizeForCrib(c);
  return cn.length > 0 && dn.includes(cn);
}

/** Levenshtein distance (small strings only). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const v0 = new Uint16Array(n + 1);
  const v1 = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) v0[j] = j;
  for (let i = 0; i < m; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < n; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= n; j++) v0[j] = v1[j];
  }
  return v0[n];
}

/** 0 = identical, 1 = completely different (normalized by max length). */
export function cribFuzzyDistance(decoded: string, crib: string): number {
  const c = crib.trim();
  if (!c) return 1;
  const d = decoded.trim();
  if (!d) return 1;
  const dist = levenshtein(d.toLowerCase(), c.toLowerCase());
  return dist / Math.max(d.length, c.length, 1);
}

/** Best fuzzy match against any substring window (capped for speed). */
export function bestWindowCribScore(decoded: string, crib: string): { start: number; end: number; dist: number } | null {
  const c = crib.trim();
  const d = decoded.trim();
  if (!c || !d || d.length > 400 || c.length > 64) return null;
  const L = c.length;
  let best: { start: number; end: number; dist: number } | null = null;
  const maxWin = Math.min(d.length, L + 16);
  for (let len = L; len <= maxWin; len++) {
    for (let i = 0; i + len <= d.length; i++) {
      const sub = d.slice(i, i + len);
      const dist = levenshtein(sub.toLowerCase(), c.toLowerCase());
      const norm = dist / Math.max(len, L, 1);
      if (!best || norm < best.dist) {
        best = { start: i, end: i + len, dist: norm };
      }
    }
  }
  return best;
}

export interface CribRow {
  jobId: string;
  ok: boolean;
  containsCrib: boolean;
  normalizedContains: boolean;
  fuzzyRatio: number | null;
  bestWindow: { start: number; end: number; dist: number } | null;
  textPreview: string;
}

export function scoreResultAgainstCrib(r: StrategyWorkerResult, crib: string): CribRow {
  const textPreview = r.ok ? r.text.replace(/\r?\n/g, ' ').slice(0, 200) : '';
  if (!r.ok || r.format === 'FORENSICS') {
    return {
      jobId: r.jobId,
      ok: r.ok,
      containsCrib: false,
      normalizedContains: false,
      fuzzyRatio: null,
      bestWindow: null,
      textPreview,
    };
  }
  const normalizedContains =
    normalizeForCrib(r.text).includes(normalizeForCrib(crib)) && normalizeForCrib(crib).length > 0;
  return {
    jobId: r.jobId,
    ok: true,
    containsCrib: containsCrib(r.text, crib),
    normalizedContains,
    fuzzyRatio: cribFuzzyDistance(r.text, crib),
    bestWindow: bestWindowCribScore(r.text, crib),
    textPreview,
  };
}
