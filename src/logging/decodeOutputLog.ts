import type { StrategyWorkerResult } from '../types.js';
import { outputEncodingHints } from '../util/outputHints.js';

const MAX_JSON_TEXT = 96_000;

export function buildDecodeOutputRecord(r: Extract<StrategyWorkerResult, { ok: true }>) {
  const text = r.text;
  const truncated = text.length > MAX_JSON_TEXT;
  const textField = truncated ? text.slice(0, MAX_JSON_TEXT) : text;
  const hints = outputEncodingHints(text);
  return {
    type: 'decode_output' as const,
    at: new Date().toISOString(),
    job_id: r.jobId,
    method_label: r.label,
    format: r.format ?? null,
    ms: r.ms,
    text: textField,
    text_truncated: truncated,
    text_length_chars: text.length,
    text_utf8_bytes: Buffer.byteLength(text, 'utf8'),
    hints,
    notes: r.notes,
  };
}

export function formatDecodeOutputHuman(r: Extract<StrategyWorkerResult, { ok: true }>): string {
  const hints = outputEncodingHints(r.text);
  const body = r.text.split(/\r?\n/).map((line) => `    ${line}`).join('\n');
  const hintBlock = hints.length ? `  hints: ${hints.join(' | ')}\n` : '';
  return (
    `[DECODE_OUTPUT]\n` +
    `  job_id: ${r.jobId}\n` +
    `  method: ${r.label}\n` +
    `  format: ${r.format ?? ''}\n` +
    `  ms: ${r.ms.toFixed(0)}\n` +
    `  text_length_chars: ${r.text.length}\n` +
    `  text_utf8_bytes: ${Buffer.byteLength(r.text, 'utf8')}\n` +
    hintBlock +
    `  text:\n${body}\n`
  );
}
