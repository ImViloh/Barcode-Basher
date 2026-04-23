#!/usr/bin/env node
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatWebEraSieveBlock } from './cipher/webEraSieve.js';
import { formatPayloadChecksumLines } from './checksum/payloadGtin.js';
import { containsCrib, scoreResultAgainstCrib } from './crib/scoring.js';
import { buildForensics } from './forensics.js';
import { createRunLogger } from './logging/runLogger.js';
import { runStrategy } from './orchestrator.js';
import { createDashboard } from './tui/dashboard.js';
import type { StrategyJob, StrategyWorkerResult } from './types.js';

const defaultImage = path.join(process.cwd(), 'samples', 'voyage-barcode.png');
const DEFAULT_CRIB = 'YOUR CHARM';

interface ParsedCli {
  image?: string;
  logDir?: string;
  crib?: string;
  noCrib?: boolean;
  /** Append-only console (no log-update). */
  plain?: boolean;
}

function parseArgs(argv: string[]): ParsedCli {
  const out: ParsedCli = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log-dir') {
      out.logDir = argv[++i];
      continue;
    }
    if (a === '--plain') {
      out.plain = true;
      continue;
    }
    if (a === '--no-crib') {
      out.noCrib = true;
      continue;
    }
    if (a === '--crib') {
      const words: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        words.push(argv[++i]);
      }
      out.crib = words.join(' ') || undefined;
      continue;
    }
    if (a.startsWith('--')) continue;
    if (!out.image) out.image = a;
  }
  return out;
}

function pickBest(results: StrategyWorkerResult[], crib: string): StrategyWorkerResult | null {
  const cribLower = crib.trim().toLowerCase();
  const hits = results.filter(
    (r): r is Extract<StrategyWorkerResult, { ok: true }> => r.ok && r.format !== 'FORENSICS',
  );
  if (hits.length === 0) {
    return results.find((r) => r.ok && r.format === 'FORENSICS') ?? null;
  }
  if (cribLower) {
    const withCrib = hits.filter((r) => containsCrib(r.text, crib));
    if (withCrib.length) {
      withCrib.sort((a, b) => {
        const ld = b.text.length - a.text.length;
        if (ld !== 0) return ld;
        return a.ms - b.ms;
      });
      return withCrib[0];
    }
  }
  hits.sort((a, b) => {
    const ld = b.text.length - a.text.length;
    if (ld !== 0) return ld;
    return a.ms - b.ms;
  });
  return hits[0] ?? null;
}

function withCrib(job: StrategyJob, crib: string): StrategyJob {
  return { ...job, extra: { ...job.extra, crib } };
}

const CORE_JOBS: StrategyJob[] = [
  { jobId: 'rle_forensics' },
  { jobId: 'forensics_png_text' },
  { jobId: 'zxing_native' },
  { jobId: 'engine_jsqr' },
  { jobId: 'engine_jsbarcode_multi' },
  { jobId: 'engine_jsbarcode_detect_rot' },
  { jobId: 'zxing_otsu_png' },
  { jobId: 'zxing_sharpen' },
  { jobId: 'zxing_normalize' },
  { jobId: 'zxing_flip_h' },
  { jobId: 'zxing_flip_v' },
  { jobId: 'zxing_rot180' },
  { jobId: 'zxing_rot90' },
  { jobId: 'zxing_rot270' },
  { jobId: 'zxing_geom_flop_rot90' },
  { jobId: 'zxing_geom_flop_rot270' },
  { jobId: 'zxing_geom_flip_rot90' },
  { jobId: 'zxing_geom_flip_rot270' },
  { jobId: 'zxing_geom_rot90_flop' },
  { jobId: 'zxing_geom_rot90_flip' },
  { jobId: 'zxing_geom_rot180_flop' },
  { jobId: 'zxing_geom_flop_rot180' },
  { jobId: 'zxing_geom_rot270_flop' },
  { jobId: 'zxing_geom_rot270_flip' },
  { jobId: 'zxing_greyscale' },
  { jobId: 'zxing_modulate_bright' },
  { jobId: 'zxing_modulate_dark' },
  { jobId: 'zxing_linear_contrast' },
  { jobId: 'zxing_blur_mild' },
  { jobId: 'zxing_vertical_bands' },
  { jobId: 'zxing_pure_barcode' },
  { jobId: 'zxing_assume_gs1' },
  { jobId: 'zxing_formats_1d_only' },
  { jobId: 'zxing_invert' },
  { jobId: 'zxing_pad_quiet' },
  { jobId: 'zxing_local_adaptive' },
  { jobId: 'bc4_block_quant_luma' },
  { jobId: 'bc7ish_block_quant_rgb' },
  { jobId: 'zxing_stretch_2x' },
  { jobId: 'zxing_threshold_sweep' },
];

/** Runs alone after the parallel batch (very CPU-heavy; avoids thrashing Sharp across workers). */
const EXHAUSTIVE_CHAIN_JOB: StrategyJob = { jobId: 'zxing_exhaustive_chains' };

const CRIB_JOBS: StrategyJob[] = [
  { jobId: 'zxing_threshold_sweep_crib' },
  { jobId: 'zxing_crib_gate_bundle' },
];

async function main() {
  const cli = parseArgs(process.argv);
  const imagePath = cli.image ? path.resolve(cli.image) : defaultImage;

  try {
    await fs.access(imagePath);
  } catch {
    console.error(`Image not found: ${imagePath}`);
    process.exitCode = 1;
    return;
  }

  const useCrib = !cli.noCrib;
  const effectiveCrib = useCrib ? (cli.crib?.trim() || DEFAULT_CRIB) : '';

  const envPlain =
    process.env.BARCODE_BASHER_PLAIN === '1' ||
    String(process.env.BARCODE_BASHER_PLAIN ?? '').toLowerCase() === 'true';
  const plain =
    cli.plain === true || envPlain || !process.stdout.isTTY;

  const parallelJobs: StrategyJob[] = (useCrib ? [...CORE_JOBS, ...CRIB_JOBS] : CORE_JOBS).map((j) =>
    useCrib ? withCrib(j, effectiveCrib) : j,
  );
  const exhaustiveJob: StrategyJob = useCrib ? withCrib(EXHAUSTIVE_CHAIN_JOB, effectiveCrib) : EXHAUSTIVE_CHAIN_JOB;

  const logger = await createRunLogger({
    imagePath,
    logDir: cli.logDir,
    crib: useCrib ? effectiveCrib : undefined,
  });

  const dashboard = createDashboard(parallelJobs.length + 1, useCrib ? effectiveCrib : undefined, { plain });
  if (plain) {
    console.log(
      chalk.bold.hex('#7CFFB2')('\nBarcode · Basher ') +
        chalk.white('(plain output)\n') +
        chalk.dim('Each strategy prints once with full text — nothing is overwritten.\n') +
        (useCrib ? chalk.hex('#FF79C6')(`CRIB: "${effectiveCrib}"\n`) : chalk.dim('CRIB: off (--no-crib)\n')),
    );
  } else {
    dashboard.render();
  }

  const forensics = await buildForensics(imagePath);
  dashboard.setForensics(forensics);
  await logger.writeForensics(forensics);

  const wave1 = await Promise.all(
    parallelJobs.map((job) =>
      runStrategy(imagePath, job).then(async (r) => {
        dashboard.upsertResult(r);
        if (r.ok) {
          await logger.writeDecodeOutput(r);
        }
        await logger.writeResult(r);
        return r;
      }),
    ),
  );

  const ex = await runStrategy(imagePath, exhaustiveJob).then(async (r) => {
    dashboard.upsertResult(r);
    if (r.ok) {
      await logger.writeDecodeOutput(r);
    }
    await logger.writeResult(r);
    return r;
  });

  const results = [...wave1, ex];

  const cribRows = useCrib ? results.map((r) => scoreResultAgainstCrib(r, effectiveCrib)) : [];
  const payloadLines: string[] = [];
  const seenDecode = new Set<string>();
  for (const r of results) {
    if (!r.ok || !r.text || r.format === 'FORENSICS') continue;
    if (seenDecode.has(r.text)) continue;
    seenDecode.add(r.text);
    payloadLines.push(...formatPayloadChecksumLines(r.jobId, r.text, r.format));
  }
  if (payloadLines.length) {
    await logger.writePayloadChecksumSection(payloadLines);
  }

  const sieveLines: string[] = [];
  const seenSieveText = new Set<string>();
  for (const r of results) {
    if (!r.ok || !r.text || r.format === 'FORENSICS') continue;
    if (seenSieveText.has(r.text)) continue;
    seenSieveText.add(r.text);
    sieveLines.push(...formatWebEraSieveBlock(r.jobId, r.text, useCrib ? effectiveCrib : undefined));
  }
  if (sieveLines.length) {
    await logger.writeWebEraSieveSection(sieveLines);
  }

  const best = pickBest(results, effectiveCrib);
  await logger.finalize({
    best,
    all: results,
    crib: useCrib ? effectiveCrib : undefined,
    cribRows: useCrib ? cribRows : undefined,
  });
  dashboard.doneBanner(best);

  const url = pathToFileURL(imagePath).href;
  console.log(
    chalk.dim('Logs:') +
      `\n  ${pathToFileURL(logger.textLogPath).href}\n  ${pathToFileURL(logger.jsonlPath).href}\n`,
  );

  if (useCrib) {
    const hits = cribRows.filter((row) => row.containsCrib || row.normalizedContains);
    if (hits.length) {
      console.log(
        chalk.green(`Crib matched (${hits.length}):`) +
          ` ${hits.map((h) => h.jobId).join(', ')}\n`,
      );
    } else {
      console.log(chalk.hex('#FF79C6')(`Crib "${effectiveCrib}" did not appear in any decode (see [CRIB] in log).\n`));
    }
  }

  if (best && best.ok && best.format !== 'FORENSICS') {
    console.log(`${chalk.dim('Source')} ${url}\n`);
  } else {
    console.log(
      `${chalk.dim('Source')} ${url}\n${chalk.yellow('Try: add white quiet margins, increase contrast, or export a lossless PNG crop, then re-run.')}\n`,
    );
  }
}

void main();
