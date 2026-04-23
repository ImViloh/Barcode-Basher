/**
 * Build run-lengths of 0/1 along a scanline where 1 = dark (bar).
 * Merges tiny runs below minRunPx into neighbors to denoise.
 */
export function binaryRunLengths(bits: Uint8Array, minRunPx = 1): number[] {
  if (bits.length === 0) return [];
  const runs: number[] = [];
  let cur = bits[0];
  let len = 1;
  for (let i = 1; i < bits.length; i++) {
    if (bits[i] === cur) {
      len++;
    } else {
      runs.push(len);
      cur = bits[i];
      len = 1;
    }
  }
  runs.push(len);
  if (minRunPx <= 1) return runs;
  return mergeShortRuns(runs, minRunPx);
}

function mergeShortRuns(runs: number[], min: number): number[] {
  if (runs.length < 3) return runs;
  const out: number[] = [...runs];
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i] < min) {
      out[i - 1] += out[i] + out[i + 1];
      out.splice(i, 2);
      i -= 2;
      if (i < 1) i = 1;
    }
  }
  return out;
}

/** Estimate quiet zone as leading/trailing light runs in projection before binarization. */
export function estimateQuietZones(proj: Float64Array, threshold: number): { left: number; right: number } {
  const light = (v: number) => v >= threshold;
  let left = 0;
  while (left < proj.length && light(proj[left])) left++;
  let right = 0;
  let x = proj.length - 1;
  while (x >= 0 && light(proj[x])) {
    right++;
    x--;
  }
  return { left, right };
}
