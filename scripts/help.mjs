#!/usr/bin/env node
console.log(`
barcode-basher — CLI flags (same as: node dist/index.js …)

  <image.png>       Image path (repo default: samples/voyage-barcode.png)
  --log-dir <dir>   Session logs (.log + .jsonl)
  --crib <words>    Known plaintext (multi-word: put tokens after --crib)
  --no-crib         Disable crib workers + crib scoring
  --plain           Append-only console (no live refresh); full text per strategy as it finishes
                    Auto-on when stdout is not a TTY (pipes / CI). Override env: BARCODE_BASHER_PLAIN=1
                    Live UI: after run, a full scrollback transcript is printed even without --plain

npm scripts
  npm run build           TypeScript → dist/ (incremental; .tsbuildinfo)
  npm run build:clean     Remove dist/ + .tsbuildinfo then full compile
  npm run build:watch     tsc --watch
  npm run clean           Remove dist/, .tsbuildinfo, and logs/
  npm run start           node dist/index.js   (requires prior build)
  npm run run             build + run-from-config (uses package.json "config")
  npm run run:fast        run-from-config only (skip tsc — fastest re-run)
  npm run run:config      same as run
  npm run run:config:fast same as run:fast
  npm run analyze         build + node dist/index.js (default image)
  npm run analyze:fast    node dist/index.js only (skip tsc)
  npm run analyze:plain   build + append-only console (--plain)
  npm run analyze:plain:fast   same, skip tsc
  npm run analyze:sample  … sample PNG only
  npm run analyze:sample:fast … sample, skip tsc
  npm run analyze:logs    … sample + --log-dir logs
  npm run analyze:logs:fast … logs, skip tsc
  npm run analyze:full    … sample + logs + crib YOUR CHARM
  npm run analyze:full:fast … full, skip tsc
  npm run analyze:no-crib … sample + logs + --no-crib
  npm run analyze:no-crib:fast … no-crib, skip tsc
  npm run decode / decode:fast / decode:logs / …   aliases for analyze:*

  Use *:fast when dist/ is already up to date (saves several seconds per run).

Decoders
  ZXing (@zxing/library) + javascript-barcode-reader + jsQR (QR) + PNG tEXt/zTXt forensics
  Post-run: MD5/ROT13/atbash/reverse/Base64/hex “web-era sieve” on each unique barcode payload
  Deep pass: zxing_exhaustive_chains runs **after** other workers — every Sharp chain (len≤4, repetition) × raw+Otsu ZXing (≤4 min wall clock)
  Forensics: file/pixel MD5+SHA256, Shannon entropy, hex + binary scanline dumps
  Post-run: GTIN/EAN/UPC check-digit analysis on unique decode strings

Logging
  Every successful strategy logs [DECODE_OUTPUT] with job_id, method (label), format,
  full text (any charset / possible Base64), plus JSONL type "decode_output".

Pass-through (overrides run-from-config defaults)
  npm run run -- ./img.png --log-dir D:/tmp --crib OTHER HINT
  npm run analyze -- ./img.png --no-crib

package.json "config" defaults (used by npm run run / run:config)
  bb_image     relative path to default image
  bb_log_dir   relative path for logs
  bb_crib      crib string (spaces OK; split into argv after --crib)
  bb_no_crib   if true, default run uses --no-crib

Change defaults without editing files (npm 8.19+):
  npm pkg set config.bb_image=path/to.png
  npm pkg set config.bb_log_dir=out-logs
  npm pkg set config.bb_crib="OTHER HINT"
  npm pkg set config.bb_no_crib=true
`);
