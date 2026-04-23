import { createHash } from 'node:crypto';

const MAX_IN = 8192;
const MAX_OUT_PREVIEW = 360;

function clip(s: string, n = MAX_OUT_PREVIEW): string {
  const t = s.replace(/\r?\n/g, '\\n');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function rot13(s: string): string {
  return [...s]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 65 && c <= 90) return String.fromCharCode(((c - 65 + 13) % 26) + 65);
      if (c >= 97 && c <= 122) return String.fromCharCode(((c - 97 + 13) % 26) + 97);
      return ch;
    })
    .join('');
}

export function atbashLetters(s: string): string {
  return [...s]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 65 && c <= 90) return String.fromCharCode(90 - (c - 65));
      if (c >= 97 && c <= 122) return String.fromCharCode(122 - (c - 97));
      return ch;
    })
    .join('');
}

export function reverseString(s: string): string {
  return [...s].reverse().join('');
}

export function md5Utf8(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

export function tryBase64Decode(s: string): { ok: true; utf8: string } | { ok: false; reason: string } {
  const t = s.replace(/\s/g, '');
  if (t.length < 8 || t.length % 4 !== 0) return { ok: false, reason: 'length' };
  if (!/^[A-Za-z0-9+/]+=*$/.test(t)) return { ok: false, reason: 'alphabet' };
  try {
    const buf = Buffer.from(t, 'base64');
    const utf8 = buf.toString('utf8');
    if (!utf8.length) return { ok: false, reason: 'empty' };
    return { ok: true, utf8 };
  } catch {
    return { ok: false, reason: 'decode' };
  }
}

export function tryHexToUtf8(s: string): { ok: true; utf8: string } | { ok: false; reason: string } {
  const t = s.replace(/\s/g, '');
  if (t.length < 4 || t.length % 2 !== 0) return { ok: false, reason: 'length' };
  if (!/^[0-9a-fA-F]+$/.test(t)) return { ok: false, reason: 'alphabet' };
  try {
    const buf = Buffer.from(t, 'hex');
    const utf8 = buf.toString('utf8');
    return { ok: true, utf8 };
  } catch {
    return { ok: false, reason: 'decode' };
  }
}

/** ROT-N for printable ASCII letters A–Z / a–z only (digits/symbols unchanged). */
export function rotNLetters(s: string, n: number): string {
  const k = ((n % 26) + 26) % 26;
  if (k === 0) return s;
  return [...s]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 65 && c <= 90) return String.fromCharCode(((c - 65 + k) % 26) + 65);
      if (c >= 97 && c <= 122) return String.fromCharCode(((c - 97 + k) % 26) + 97);
      return ch;
    })
    .join('');
}

/** Vigenère decrypt; key uses A–Z letters from phrase; key advances only on letter shifts. */
export function vigenereDecryptLetters(cipher: string, keyPhrase: string): string {
  const k = keyPhrase.toUpperCase().replace(/[^A-Z]/g, '');
  if (!k.length) return '';
  let j = 0;
  return [...cipher]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 65 && c <= 90) {
        const K = k.charCodeAt(j % k.length) - 65;
        j++;
        return String.fromCharCode(((c - 65 - K + 26) % 26) + 65);
      }
      if (c >= 97 && c <= 122) {
        const K = k.charCodeAt(j % k.length) - 65;
        j++;
        return String.fromCharCode(((c - 97 - K + 26) % 26) + 97);
      }
      return ch;
    })
    .join('');
}

export interface WebEraSieveOpts {
  crib?: string;
  maxLines?: number;
}

/**
 * Lines for logs — mirrors “open a dozen browser tabs” style checks (encodings + simple ciphers).
 */
export function buildWebEraSieveLines(label: string, raw: string, opts?: WebEraSieveOpts): string[] {
  const maxLines = opts?.maxLines ?? 44;
  const crib = opts?.crib?.trim() ?? '';
  const s = raw.length > MAX_IN ? raw.slice(0, MAX_IN) : raw;
  const lines: string[] = [`label=${label} · md5(utf8)=${md5Utf8(s)} · len=${raw.length}`];
  lines.push(`rev: ${clip(reverseString(s))}`);
  lines.push(`rot13: ${clip(rot13(s))}`);
  lines.push(`atbash: ${clip(atbashLetters(s))}`);

  for (let n = 0; n < 26 && lines.length < maxLines - 6; n++) {
    lines.push(`rot${n}: ${clip(rotNLetters(s, n), 140)}`);
  }

  const b64 = tryBase64Decode(s);
  if (b64.ok) lines.push(`b64→utf8: ${clip(b64.utf8)}`);
  else lines.push(`b64: (${b64.reason})`);

  const hx = tryHexToUtf8(s);
  if (hx.ok) lines.push(`hex→utf8: ${clip(hx.utf8)}`);
  else lines.push(`hex: (${hx.reason})`);

  if (crib.length) {
    const vig = vigenereDecryptLetters(s, crib);
    if (vig.length) lines.push(`vigenère(key=crib): ${clip(vig)}`);
  }

  return lines.slice(0, maxLines);
}

export function formatWebEraSieveBlock(jobId: string, text: string, crib?: string): string[] {
  const body = buildWebEraSieveLines(`decode:${jobId}`, text, { crib: crib?.trim() || undefined });
  return [`[WEB_SIEVE] source=barcode_decode job_id=${jobId}`, ...body.map((l) => `  ${l}`), ''];
}
