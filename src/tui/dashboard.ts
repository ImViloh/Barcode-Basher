import boxen from 'boxen';
import chalk from 'chalk';
import logUpdate from 'log-update';
import stripAnsi from 'strip-ansi';
import type { ImageForensics } from '../types.js';
import type { StrategyWorkerResult } from '../types.js';

const TRANSCRIPT_TEXT_CAP = 48_000;
const TRANSCRIPT_NOTES_CAP = 12_000;

export interface DashboardOptions {
  /** Append-only console (no in-place refresh). Implied when stdout is not a TTY. */
  plain?: boolean;
}

const brand = chalk.hex('#7CFFB2')('Barcode');
const title = chalk.bold.white('Basher');
const divider = chalk.dim('─'.repeat(72));

function padVisible(s: string, width: number): string {
  const vis = stripAnsi(s);
  if (vis.length >= width) return s;
  return s + ' '.repeat(width - vis.length);
}

function statusLine(done: number, total: number, elapsedMs: number): string {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const barW = 28;
  const filled = Math.round((pct / 100) * barW);
  const bar = chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(barW - filled));
  return `${chalk.bold('Workers')}: ${done}/${total} ${bar} ${chalk.cyan(`${pct}%`)} · ${chalk.yellow(`${(elapsedMs / 1000).toFixed(1)}s`)}`;
}

function forensicsBox(f: ImageForensics): string {
  const binShow =
    f.binaryScanlineOtsu.length > 140 ? `${f.binaryScanlineOtsu.slice(0, 140)}…` : f.binaryScanlineOtsu;
  const rows = [
    chalk.bold('Image forensics'),
    divider,
    `${chalk.dim('Path')} ${f.path}`,
    `${chalk.dim('Raster')} ${f.width}×${f.height}px · ch ${f.channels}`,
    `${chalk.dim('Luma μ/min/max')} ${f.meanLuma.toFixed(1)} / ${f.minLuma} / ${f.maxLuma}`,
    `${chalk.dim('Otsu T')} ${f.otsuThreshold}`,
    `${chalk.dim('Entropy')} luma ${f.entropyLumaGlobal.toFixed(3)} · row-raw ${f.entropyCenterRowRgba.toFixed(3)} bits/sym`,
    `${chalk.dim('File MD5')} ${f.checksums.fileMd5}  ${chalk.dim('SHA256')} ${f.checksums.fileSha256.slice(0, 18)}…`,
    `${chalk.dim('Raster MD5')} ${f.checksums.rawPixelMd5}  ${chalk.dim('bytes')} ${f.checksums.rawPixelBytes}`,
    `${chalk.dim('Quiet-zone guess')} L ${f.quietZoneEstimatePx.left}px · R ${f.quietZoneEstimatePx.right}px`,
    `${chalk.dim('Projection (96 samples, 0-1)')} ${f.projectionSample.map((v) => v.toFixed(2)).join(' ')}`,
    `${chalk.dim('Run preview')} ${f.moduleRunPreview.join(',')}`,
    `${chalk.dim('Binary row (Otsu)')} ${binShow}`,
    `${chalk.dim('Hex row')} ${f.hexCenterRowRgba.split('\n')[0] ?? ''}`,
  ];
  return boxen(rows.join('\n'), {
    padding: 1,
    margin: { top: 0, right: 0, bottom: 1, left: 0 },
    borderStyle: 'round',
    borderColor: '#56B4E9',
    title: 'Signal',
    titleAlignment: 'left',
  });
}

function resultLine(r: StrategyWorkerResult, width: number): string {
  if (r.ok) {
    const head = chalk.green('✔');
    const label = chalk.bold.white(padVisible(r.label, 34));
    const fmt = chalk.magenta(r.format ?? '?');
    const ms = chalk.dim(`${r.ms.toFixed(0)}ms`);
    const snippet = chalk.gray(r.text.length > width - 40 ? `${r.text.slice(0, width - 43)}…` : r.text);
    return `${head} ${label} ${fmt} ${ms}\n   ${chalk.cyan(snippet)}`;
  }
  const head = chalk.red('✖');
  const label = chalk.bold.gray(padVisible(r.label, 34));
  const ms = chalk.dim(`${r.ms.toFixed(0)}ms`);
  return `${head} ${label} ${ms}\n   ${chalk.red(r.error)}`;
}

function clipBody(s: string, cap: number): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false };
  return { text: `${s.slice(0, cap)}\n… (${s.length - cap} more characters not shown)`, truncated: true };
}

/** Every strategy outcome with full payload — safe for terminal scrollback / pipes. */
export function formatResultsTranscript(state: DashboardState): string {
  const blocks: string[] = [];
  blocks.push(chalk.bold.white(`── Full strategy results (${state.order.length}) · scrollback-safe ──`));
  for (const id of state.order) {
    const r = state.results.get(id);
    if (!r) continue;
    if (r.ok) {
      const body = clipBody(r.text, TRANSCRIPT_TEXT_CAP);
      const notesJoined = r.notes.join('\n');
      const notesClip = clipBody(notesJoined, TRANSCRIPT_NOTES_CAP);
      blocks.push(
        chalk.green(`[OK] ${r.jobId}`) +
          `\n  ${chalk.dim('label:')} ${r.label}\n  ${chalk.dim('format:')} ${r.format ?? ''}\n  ${chalk.dim('ms:')} ${r.ms.toFixed(0)}` +
          (body.truncated ? chalk.yellow('\n  (text truncated for console)') : '') +
          `\n  ${chalk.dim('text:')}\n${chalk.white(body.text)}` +
          (r.notes.length
            ? `\n  ${chalk.dim('notes:')}\n${notesClip.text}${notesClip.truncated ? chalk.yellow('\n  (notes truncated)') : ''}`
            : ''),
      );
    } else {
      blocks.push(
        chalk.red(`[FAIL] ${r.jobId}`) +
          `\n  ${chalk.dim('label:')} ${r.label}\n  ${chalk.dim('ms:')} ${r.ms.toFixed(0)}\n  ${chalk.red('error:')} ${r.error}` +
          (r.notes.length ? `\n  ${chalk.dim('notes:')}\n${r.notes.join('\n')}` : ''),
      );
    }
    blocks.push('');
  }
  return blocks.join('\n');
}

export interface DashboardState {
  forensics: ImageForensics | null;
  results: Map<string, StrategyWorkerResult>;
  order: string[];
  startedAt: number;
  totalStrategies: number;
  crib?: string;
}

export function createDashboard(totalStrategies: number, crib?: string, options?: DashboardOptions) {
  const plain = options?.plain === true;
  const state: DashboardState = {
    forensics: null,
    results: new Map(),
    order: [],
    startedAt: Date.now(),
    totalStrategies,
    crib,
  };

  function upsertResult(r: StrategyWorkerResult) {
    if (!state.results.has(r.jobId)) state.order.push(r.jobId);
    state.results.set(r.jobId, r);
    if (plain) {
      const termW = Math.min(160, process.stdout.columns || 160);
      console.log(resultLine(r, termW));
      if (r.ok) {
        const body = clipBody(r.text, TRANSCRIPT_TEXT_CAP);
        console.log(chalk.dim('  text (full):'));
        console.log(chalk.white(body.text));
        if (body.truncated) console.log(chalk.yellow(`  (payload exceeds ${TRANSCRIPT_TEXT_CAP} chars; see log file for full dump)`));
        if (r.notes.length) {
          const nc = clipBody(r.notes.join('\n'), TRANSCRIPT_NOTES_CAP);
          console.log(chalk.dim('  notes:'));
          console.log(nc.text);
          if (nc.truncated) console.log(chalk.yellow('  (notes truncated)'));
        }
      } else if (r.notes.length) {
        console.log(chalk.dim('  notes:'), r.notes.join(' | '));
      }
      console.log(
        chalk.dim(
          `— Progress ${state.results.size}/${state.totalStrategies} · ${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`,
        ),
      );
      return;
    }
    render();
  }

  function setForensics(f: ImageForensics) {
    state.forensics = f;
    if (plain) {
      console.log('\n' + forensicsBox(f) + '\n');
      return;
    }
    render();
  }

  function render() {
    if (plain) return;
    const termW = Math.min(110, process.stdout.columns || 100);
    const elapsed = Date.now() - state.startedAt;
    const cribLine = state.crib
      ? chalk.hex('#FF79C6')(`CRIB: "${state.crib}"`)
      : chalk.dim('CRIB: off (--no-crib)');
    const header = boxen(
      `${brand}${chalk.white(' · ')}${title}\n${chalk.dim('Multi-strategy decode · worker_threads · TypeScript')}\n${cribLine}`,
      {
      padding: 1,
      margin: { bottom: 1, top: 0, left: 0, right: 0 },
      borderStyle: 'double',
      borderColor: '#FFB86C',
    },
    );

    const fx = state.forensics ? forensicsBox(state.forensics) : chalk.dim('Collecting forensics…');

    const lines: string[] = [];
    lines.push(statusLine(state.results.size, state.totalStrategies, elapsed));
    lines.push(divider);
    for (const id of state.order) {
      const r = state.results.get(id);
      if (r) lines.push(resultLine(r, termW));
    }
    const body = boxen(lines.join('\n') || chalk.dim('Scheduling workers…'), {
      padding: 1,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
      borderStyle: 'single',
      borderColor: '#BD93F9',
      title: 'Strategies',
      titleAlignment: 'left',
    });

    logUpdate(`${header}\n${fx}\n${body}`);
  }

  function doneBanner(best: StrategyWorkerResult | null) {
    if (!plain) {
      logUpdate.done();
      console.log('\n' + formatResultsTranscript(state) + '\n');
    } else {
      console.log(
        chalk.dim(
          `\n── End of run · ${state.order.length} strategies above (full text each) · best decode follows ──\n`,
        ),
      );
    }
    if (best && best.ok && best.format !== 'FORENSICS') {
      const disp = clipBody(best.text, 14_000);
      const tail = disp.truncated ? chalk.yellow('\n\n(console preview truncated; full payload in transcript block or .log)') : '';
      console.log(
        boxen(`${chalk.green.bold('Decoded payload')}\n\n${chalk.white(disp.text)}${tail}\n\n${chalk.dim(best.format ?? '')}`, {
          padding: 1,
          margin: { top: 1, bottom: 0 },
          borderStyle: 'round',
          borderColor: '#50FA7B',
        }),
      );
    } else if (best && best.ok && best.format === 'FORENSICS') {
      const disp = clipBody(best.text, 14_000);
      const tail = disp.truncated ? chalk.yellow('\n\n(console preview truncated; see .log for full block)') : '';
      console.log(
        boxen(`${chalk.cyan.bold('Forensics summary (not a symbology decode)')}\n\n${chalk.white(disp.text)}${tail}`, {
          padding: 1,
          margin: { top: 1, bottom: 0 },
          borderStyle: 'round',
          borderColor: '#8BE9FD',
        }),
      );
    } else {
      console.log(
        boxen(chalk.yellow('No strategy produced a scanner-grade decode.\nForensics + RLE still describe the signal.'), {
          padding: 1,
          margin: { top: 1 },
          borderStyle: 'round',
          borderColor: '#F1FA8C',
        }),
      );
    }
  }

  return { upsertResult, setForensics, render, doneBanner, state };
}
