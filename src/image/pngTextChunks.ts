import { inflateSync } from 'node:zlib';

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function readU32BE(buf: Uint8Array, o: number): number {
  return (buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
}

function chunkType(buf: Uint8Array, o: number): string {
  return String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
}

export interface PngTextChunk {
  type: 'tEXt' | 'zTXt';
  keyword: string;
  text: string;
}

/**
 * Extract human-readable strings from PNG tEXt / zTXt chunks (no extra npm deps).
 * Returns [] if the buffer is not a PNG or has no such chunks.
 */
export function extractPngTextChunks(buf: Uint8Array): PngTextChunk[] {
  if (buf.length < 24) return [];
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (buf[i] !== PNG_SIG[i]) return [];
  }

  const out: PngTextChunk[] = [];
  let o = 8;

  while (o + 12 <= buf.length) {
    const len = readU32BE(buf, o);
    const typ = chunkType(buf, o + 4);
    const dataStart = o + 8;
    const dataEnd = dataStart + len;
    const next = dataEnd + 4;
    if (dataEnd > buf.length || next > buf.length) break;

    if (typ === 'tEXt' && len > 0) {
      const slice = buf.subarray(dataStart, dataEnd);
      const z = slice.indexOf(0);
      if (z > 0 && z < 80) {
        const keyword = latin1(slice.subarray(0, z));
        const text = latin1(slice.subarray(z + 1));
        out.push({ type: 'tEXt', keyword, text });
      }
    } else if (typ === 'zTXt' && len > 2) {
      const slice = buf.subarray(dataStart, dataEnd);
      const z = slice.indexOf(0);
      if (z > 0 && z < 80 && z + 2 < slice.length) {
        const keyword = latin1(slice.subarray(0, z));
        const comp = slice[z + 1];
        const payload = slice.subarray(z + 2);
        if (comp === 0) {
          try {
            const inflated = inflateSync(Buffer.from(payload));
            const text = inflated.toString('utf8');
            out.push({ type: 'zTXt', keyword, text });
          } catch {
            /* skip malformed zlib */
          }
        }
      }
    }

    o = next;
  }

  return out;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
