import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Package ships UMD/CJS; default export is the decoder function.
const mod = require('javascript-barcode-reader') as { default?: (opts: unknown) => Promise<string> } | ((opts: unknown) => Promise<string>);
const javascriptBarcodeReader =
  typeof mod === 'function' ? mod : (mod as { default: (opts: unknown) => Promise<string> }).default;

type TrySpec = { barcode: string; barcodeType?: string; optLabel: string; opts: Record<string, boolean> };

const TRY_MATRIX: TrySpec[] = [
  { barcode: 'code-128', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
  { barcode: 'code-128', optLabel: 'default', opts: {} },
  { barcode: 'code-39', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
  { barcode: 'code-93', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
  { barcode: 'ean-13', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
  { barcode: 'ean-8', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
  { barcode: 'upc-a', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
  { barcode: 'upc-e', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
  { barcode: 'codabar', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
  { barcode: 'code-2of5', barcodeType: 'interleaved', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
  { barcode: 'code-2of5', barcodeType: 'industrial', optLabel: 'adaptive+locate', opts: { useAdaptiveThreshold: true, locateBarcode: true } },
];

export interface JsReaderHit {
  text: string;
  barcode: string;
  barcodeType?: string;
  optLabel: string;
}

/**
 * javascript-barcode-reader (non-ZXing) — tries several symbologies / option sets.
 */
export async function decodeWithJavascriptBarcodeReader(imagePath: string): Promise<JsReaderHit[]> {
  const hits: JsReaderHit[] = [];
  const seen = new Set<string>();

  for (const spec of TRY_MATRIX) {
    try {
      const text = await javascriptBarcodeReader({
        image: imagePath,
        barcode: spec.barcode,
        barcodeType: spec.barcodeType,
        options: spec.opts,
      });
      const t = String(text ?? '').trim();
      if (!t) continue;
      const key = `${spec.barcode}|${spec.barcodeType ?? ''}|${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        text: t,
        barcode: spec.barcode,
        barcodeType: spec.barcodeType,
        optLabel: spec.optLabel,
      });
    } catch {
      /* continue */
    }
  }
  return hits;
}

const DETECT_ROT_SPECS: { barcode: string; barcodeType?: string }[] = [
  { barcode: 'code-128' },
  { barcode: 'code-39' },
  { barcode: 'code-93' },
  { barcode: 'ean-13' },
  { barcode: 'ean-8' },
  { barcode: 'upc-a' },
  { barcode: 'upc-e' },
  { barcode: 'codabar' },
  { barcode: 'code-2of5', barcodeType: 'interleaved' },
  { barcode: 'code-2of5', barcodeType: 'industrial' },
];

/**
 * Same symbology sweep as {@link decodeWithJavascriptBarcodeReader}, but with
 * `detectRotation: true` so the library can correct sideways / upside-down crops.
 */
export async function decodeWithJavascriptBarcodeReaderDetectRotation(imagePath: string): Promise<JsReaderHit[]> {
  const hits: JsReaderHit[] = [];
  const seen = new Set<string>();
  const opts = { detectRotation: true, locateBarcode: true, useAdaptiveThreshold: true };

  for (const spec of DETECT_ROT_SPECS) {
    try {
      const text = await javascriptBarcodeReader({
        image: imagePath,
        barcode: spec.barcode,
        barcodeType: spec.barcodeType,
        options: opts,
      });
      const t = String(text ?? '').trim();
      if (!t) continue;
      const key = `${spec.barcode}|${spec.barcodeType ?? ''}|${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        text: t,
        barcode: spec.barcode,
        barcodeType: spec.barcodeType,
        optLabel: 'detectRotation+adaptive+locate',
      });
    } catch {
      /* continue */
    }
  }
  return hits;
}
