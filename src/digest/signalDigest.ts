import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function md5Hex(data: Buffer | Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function hashFileBytes(imagePath: string): Promise<{ size: number; md5: string; sha256: string }> {
  const buf = await readFile(imagePath);
  return { size: buf.length, md5: md5Hex(buf), sha256: sha256Hex(buf) };
}

export function hexDump(bytes: Uint8Array, maxBytes = 96): string {
  const n = Math.min(bytes.length, maxBytes);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 16) {
    const slice = bytes.subarray(i, Math.min(i + 16, n));
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    parts.push(`${i.toString(16).padStart(4, '0')}  ${hex}`);
  }
  if (bytes.length > maxBytes) parts.push(`… +${bytes.length - maxBytes} bytes`);
  return parts.join('\n');
}

/** 0/1 string for barcode row bits (truncated). */
export function bitsToBinaryString(bits: Uint8Array, maxBits = 512): string {
  let s = '';
  const n = Math.min(bits.length, maxBits);
  for (let i = 0; i < n; i++) s += bits[i] ? '1' : '0';
  if (bits.length > maxBits) s += `…(+${bits.length - maxBits} bits)`;
  return s;
}

export function shannonEntropy(u8: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < u8.length; i++) hist[u8[i]]++;
  let H = 0;
  const n = u8.length || 1;
  for (let i = 0; i < 256; i++) {
    const c = hist[i];
    if (c > 0) {
      const p = c / n;
      H -= p * Math.log2(p);
    }
  }
  return H;
}
