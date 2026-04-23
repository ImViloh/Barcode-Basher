/**
 * Non-blocking hints about how a payload might be encoded.
 * Never used to reject or filter outputs — arbitrary bytes/Unicode are valid.
 */
export function outputEncodingHints(text: string): string[] {
  const hints: string[] = [];
  const trimmed = text.replace(/\s/g, '');
  if (trimmed.length >= 8 && trimmed.length % 4 === 0 && /^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
    hints.push('shape: could be Base64 (heuristic only, not decoded)');
  }
  if (trimmed.length >= 16 && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    hints.push('shape: could be hex (heuristic only)');
  }
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 127) nonAscii++;
  }
  if (nonAscii > 0) {
    hints.push(`contains ${nonAscii} code point(s) above U+007F`);
  }
  const ctrl = [...text].filter((c) => {
    const u = c.charCodeAt(0);
    return u < 32 && u !== 9 && u !== 10 && u !== 13;
  }).length;
  if (ctrl > 0) hints.push(`contains ${ctrl} C0 control character(s) excluding tab/LF/CR`);
  return hints;
}
