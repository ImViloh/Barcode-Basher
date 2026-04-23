/** Strip to digits only. */
export function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/** GTIN / UPC / EAN check digit (mod 10) for lengths 8,12,13,14. */
export function gtinCheckDigit(bodyWithoutCheck: string): number | null {
  const d = digitsOnly(bodyWithoutCheck);
  if (![7, 11, 12, 13].includes(d.length)) return null;
  let sum = 0;
  const rev = d.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    const n = parseInt(rev[i], 10);
    if (Number.isNaN(n)) return null;
    sum += i % 2 === 0 ? n * 3 : n;
  }
  return (10 - (sum % 10)) % 10;
}

export interface GtinCheckResult {
  kind: 'EAN-13' | 'EAN-8' | 'UPC-A' | 'GTIN-14' | 'unknown';
  valid: boolean | null;
  detail: string;
}

export function analyzeGtinLikePayload(text: string): GtinCheckResult {
  const d = digitsOnly(text);
  if (d.length === 13) {
    const want = gtinCheckDigit(d.slice(0, 12));
    const got = parseInt(d[12], 10);
    const ok = want === got;
    return { kind: 'EAN-13', valid: ok, detail: `check digit expect ${want} got ${got}` };
  }
  if (d.length === 8) {
    const want = gtinCheckDigit(d.slice(0, 7));
    const got = parseInt(d[7], 10);
    const ok = want === got;
    return { kind: 'EAN-8', valid: ok, detail: `check digit expect ${want} got ${got}` };
  }
  if (d.length === 12) {
    const want = gtinCheckDigit(d.slice(0, 11));
    const got = parseInt(d[11], 10);
    const ok = want === got;
    return { kind: 'UPC-A', valid: ok, detail: `check digit expect ${want} got ${got}` };
  }
  if (d.length === 14) {
    const want = gtinCheckDigit(d.slice(0, 13));
    const got = parseInt(d[13], 10);
    const ok = want === got;
    return { kind: 'GTIN-14', valid: ok, detail: `check digit expect ${want} got ${got}` };
  }
  return {
    kind: 'unknown',
    valid: null,
    detail: d.length ? `digit run length ${d.length} (not 8/12/13/14)` : 'no digits',
  };
}

export function formatPayloadChecksumLines(jobId: string, text: string, format?: string): string[] {
  const g = analyzeGtinLikePayload(text);
  const head = `[payload] ${jobId}${format ? ` (${format})` : ''}`;
  const lines = [
    head,
    `  text: ${text.replace(/\r?\n/g, ' ').slice(0, 200)}${text.length > 200 ? '…' : ''}`,
    `  ${g.kind}: ${g.valid === null ? 'n/a' : g.valid ? 'CHECK OK' : 'CHECK FAIL'} — ${g.detail}`,
  ];
  return lines;
}
