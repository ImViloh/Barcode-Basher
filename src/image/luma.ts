import sharp from 'sharp';

export interface GrayFrame {
  width: number;
  height: number;
  /** row-major luminance 0-255 */
  luma: Uint8Array;
}

export interface RawRgbaFrame {
  width: number;
  height: number;
  channels: number;
  rgba: Uint8Array;
}

/** Same resize rules as loadGrayFrame — use for checksums/hex aligned with luma. */
export async function loadRawRgbaFrame(imagePath: string, maxWidth = 12_000): Promise<RawRgbaFrame> {
  const pipeline = sharp(imagePath).ensureAlpha().raw();
  const meta = await pipeline.metadata();
  const w0 = meta.width ?? 0;
  const h0 = meta.height ?? 0;
  if (!w0 || !h0) throw new Error('Could not read image dimensions');

  let resize = pipeline;
  if (w0 > maxWidth) {
    resize = sharp(imagePath)
      .resize({ width: maxWidth, withoutEnlargement: true, kernel: sharp.kernel.lanczos3 })
      .ensureAlpha()
      .raw();
  }

  const { data, info } = await resize.toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    rgba: new Uint8Array(data),
  };
}

function lumaFromRaw(width: number, height: number, channels: number, rgba: Uint8Array): Uint8Array {
  const luma = new Uint8Array(width * height);
  if (channels === 1 || channels === 2) {
    const step = channels;
    for (let i = 0, p = 0; i < width * height; i++, p += step) {
      luma[i] = rgba[p];
    }
  } else {
    for (let i = 0, p = 0; i < width * height; i++, p += channels) {
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      luma[i] = ((r * 306 + g * 601 + b * 117) + 512) >> 10;
    }
  }
  return luma;
}

/** Single decode pass: raw RGBA (or gray+alpha) + luminance. */
export async function loadAnalysisFrame(
  imagePath: string,
  maxWidth = 12_000,
): Promise<RawRgbaFrame & GrayFrame> {
  const raw = await loadRawRgbaFrame(imagePath, maxWidth);
  const luma = lumaFromRaw(raw.width, raw.height, raw.channels, raw.rgba);
  return { ...raw, luma };
}

export async function loadGrayFrame(imagePath: string, maxWidth = 12_000): Promise<GrayFrame> {
  const { width, height, luma } = await loadAnalysisFrame(imagePath, maxWidth);
  return { width, height, luma };
}

export function columnMeanProjection(luma: Uint8Array, width: number, height: number): Float64Array {
  const proj = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    let acc = 0;
    const col = x;
    for (let y = 0; y < height; y++) acc += luma[y * width + col];
    proj[x] = acc / height;
  }
  return proj;
}
