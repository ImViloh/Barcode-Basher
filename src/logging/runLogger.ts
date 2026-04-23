import fs from 'node:fs/promises';
import path from 'node:path';
import type { CribRow } from '../crib/scoring.js';
import { buildDecodeOutputRecord, formatDecodeOutputHuman } from './decodeOutputLog.js';
import type { ImageForensics, StrategyWorkerResult } from '../types.js';

export interface RunLoggerOptions {
  imagePath: string;
  logDir?: string;
  /** Plaintext crib (logged; used for post-run scoring block). */
  crib?: string;
}

export interface RunLogger {
  readonly textLogPath: string;
  readonly jsonlPath: string;
  writeLine(line: string): Promise<void>;
  writeForensics(f: ImageForensics): Promise<void>;
  /** Every successful strategy with a text payload (symbology, JS engine, or FORENSICS). */
  writeDecodeOutput(r: Extract<StrategyWorkerResult, { ok: true }>): Promise<void>;
  writePayloadChecksumSection(lines: string[]): Promise<void>;
  /** ROT13 / atbash / Base64+hex tries on unique barcode payloads (web-era ARG patterns). */
  writeWebEraSieveSection(lines: string[]): Promise<void>;
  writeResult(r: StrategyWorkerResult): Promise<void>;
  finalize(summary: {
    best: StrategyWorkerResult | null;
    all: StrategyWorkerResult[];
    crib?: string;
    cribRows?: CribRow[];
  }): Promise<void>;
}

async function append(file: string, chunk: string) {
  await fs.appendFile(file, chunk, 'utf8');
}

export async function createRunLogger(opts: RunLoggerOptions): Promise<RunLogger> {
  const baseDir = path.resolve(opts.logDir ?? path.join(process.cwd(), 'logs'));
  await fs.mkdir(baseDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(baseDir, `run-${stamp}`);
  const textLogPath = `${base}.log`;
  const jsonlPath = `${base}.jsonl`;

  const header =
    `# Barcode Basher session\n` +
    `# started: ${new Date().toISOString()}\n` +
    `# image: ${opts.imagePath}\n` +
    `# crib: ${opts.crib ? `"${opts.crib.replace(/"/g, '\\"')}"` : '(off)'}\n` +
    `${'='.repeat(80)}\n\n`;

  await fs.writeFile(textLogPath, header, 'utf8');
  await fs.writeFile(jsonlPath, '', 'utf8');

  const writeJsonl = (obj: unknown) => append(jsonlPath, JSON.stringify(obj) + '\n');

  await writeJsonl({
    type: 'session_start',
    imagePath: opts.imagePath,
    crib: opts.crib ?? null,
    at: new Date().toISOString(),
  });

  return {
    textLogPath,
    jsonlPath,
    async writeLine(line: string) {
      await append(textLogPath, line + '\n');
    },
    async writeForensics(f: ImageForensics) {
      await writeJsonl({ type: 'forensics', at: new Date().toISOString(), forensics: f });
      const binPrev =
        f.binaryScanlineOtsu.length > 240 ? `${f.binaryScanlineOtsu.slice(0, 240)}…` : f.binaryScanlineOtsu;
      const hexLines = f.hexCenterRowRgba.split('\n').slice(0, 8).join('\n  ');
      const block =
        `[FORENSICS]\n` +
        `  dimensions: ${f.width}x${f.height} · channels: ${f.channels}\n` +
        `  luma mean/min/max: ${f.meanLuma.toFixed(2)} / ${f.minLuma} / ${f.maxLuma}\n` +
        `  otsu: ${f.otsuThreshold}\n` +
        `  entropy (luma global / center row raw): ${f.entropyLumaGlobal.toFixed(4)} / ${f.entropyCenterRowRgba.toFixed(4)} bits/sym\n` +
        `  file bytes: ${f.checksums.fileSize} · md5: ${f.checksums.fileMd5}\n` +
        `  file sha256: ${f.checksums.fileSha256}\n` +
        `  raw raster bytes: ${f.checksums.rawPixelBytes} · md5: ${f.checksums.rawPixelMd5}\n` +
        `  raw raster sha256: ${f.checksums.rawPixelSha256}\n` +
        `  quiet zone px L/R: ${f.quietZoneEstimatePx.left} / ${f.quietZoneEstimatePx.right}\n` +
        `  projection_sample: ${f.projectionSample.map((v) => v.toFixed(3)).join(',')}\n` +
        `  module_run_preview: ${f.moduleRunPreview.join(',')}\n` +
        `  binary_scanline_otsu_preview: ${binPrev}\n` +
        `  hex_center_row (partial):\n  ${hexLines}\n\n`;
      await append(textLogPath, block);
    },
    async writePayloadChecksumSection(lines: string[]) {
      await writeJsonl({ type: 'payload_checksum', at: new Date().toISOString(), lines });
      await append(textLogPath, `[PAYLOAD_CHECKSUM]\n${lines.join('\n')}\n\n`);
    },
    async writeWebEraSieveSection(lines: string[]) {
      await writeJsonl({ type: 'web_era_sieve', at: new Date().toISOString(), lines });
      await append(textLogPath, `${lines.join('\n')}\n`);
    },
    async writeDecodeOutput(r) {
      await writeJsonl(buildDecodeOutputRecord(r));
      await append(textLogPath, `${formatDecodeOutputHuman(r)}\n`);
    },
    async writeResult(r: StrategyWorkerResult) {
      await writeJsonl({ type: 'strategy_result', at: new Date().toISOString(), result: r });
      if (r.ok) {
        const preview =
          r.text.length > 220 ? `${r.text.slice(0, 220).replace(/\r?\n/g, ' ')}…` : r.text.replace(/\r?\n/g, ' ');
        await append(
          textLogPath,
          `[OK] ${r.jobId} | ${r.ms.toFixed(0)}ms | format=${r.format ?? ''}\n` +
            `  label: ${r.label}\n` +
            `  text_preview: ${preview}\n` +
            `  (full payload + method: see preceding [DECODE_OUTPUT] for this job_id)\n` +
            (r.notes.length ? `  notes: ${r.notes.join(' | ')}\n` : '') +
            `\n`,
        );
      } else {
        await append(
          textLogPath,
          `[FAIL] ${r.jobId} | ${r.ms.toFixed(0)}ms\n` +
            `  label: ${r.label}\n` +
            `  error: ${r.error}\n` +
            (r.notes.length ? `  notes: ${r.notes.join(' | ')}\n` : '') +
            `\n`,
        );
      }
    },
    async finalize(summary) {
      if (summary.crib && summary.cribRows?.length) {
        await writeJsonl({
          type: 'crib_report',
          at: new Date().toISOString(),
          crib: summary.crib,
          rows: summary.cribRows,
        });
        let cribBlock = `[CRIB] target: "${summary.crib}"\n`;
        for (const row of summary.cribRows) {
          const bits = [
            `  ${row.jobId}`,
            row.ok ? 'ok' : 'fail',
            row.containsCrib ? 'CONTAINS' : '-',
            row.normalizedContains ? 'NORM' : '-',
            row.fuzzyRatio != null ? `fuzzy≈${row.fuzzyRatio.toFixed(3)}` : 'fuzzy=n/a',
            row.bestWindow ? `windowScore≈${row.bestWindow.dist.toFixed(3)}@[${row.bestWindow.start},${row.bestWindow.end})` : '',
          ]
            .filter(Boolean)
            .join(' | ');
          cribBlock += bits + '\n';
          if (row.textPreview) cribBlock += `    preview: ${row.textPreview}\n`;
        }
        cribBlock += '\n';
        await append(textLogPath, cribBlock);
      }

      await writeJsonl({
        type: 'session_end',
        at: new Date().toISOString(),
        best: summary.best,
        counts: { total: summary.all.length, ok: summary.all.filter((x) => x.ok).length },
      });
      const best = summary.best;
      const tail =
        `[SUMMARY]\n` +
        (best && best.ok
          ? best.format === 'FORENSICS'
            ? `  best (forensics): ${best.text}\n`
            : `  best decode: ${best.text}\n  format: ${best.format}\n  strategy: ${best.jobId}\n`
          : `  no successful decode\n`) +
        `\n`;
      await append(textLogPath, tail);
    },
  };
}
