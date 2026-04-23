# Barcode Basher

**Node.js + TypeScript CLI** for aggressive **1D barcode** and **QR** decoding, **image forensics**, and **payload analysis**. It runs **dozens of independent strategies in parallel** (`worker_threads`), scores results against an optional **crib** (known plaintext), and writes **structured session logs** (human-readable `.log` + JSONL).

Use it when a single decoder or a single preprocess pass is not enough: noisy captures, odd geometry, synthetic “BC” texture simulations, hidden PNG metadata, or payloads that need encoding checks after decode.

---

## What it does

| Area | Behavior |
|------|----------|
| **Decoders** | **ZXing** (1D + 2D), **javascript-barcode-reader** (1D symbology sweep + optional rotation detection), **jsQR** (QR, separate from ZXing). |
| **Preprocess** | **[Sharp](https://sharp.pixelplumbing.com/)** pipelines: normalize, sharpen, blur, invert, greyscale, modulate, linear contrast, padding, local adaptive thresholding, vertical band crops, 2× stretch, many **flip / rotate / compound geometry** chains. |
| **Deep sweep** | **`zxing_exhaustive_chains`** runs **after** the parallel batch: every ordered composition of a fixed set of Sharp ops up to **length 4** (with repetition), each frame decoded with ZXing on **raw luma** and on an **Otsu-binarized** fake RGBA. Bounded by a wall clock (see source: `EXHAUSTIVE_TIMEOUT_MS`). |
| **Simulation** | Optional **BC4-ish** / **BC7-ish** block quantization passes before ZXing (texture / compression artifact experiments). |
| **Forensics** | File + raw raster checksums (MD5/SHA256), Shannon entropy, center-row **hex** + **Otsu binary scanline**, projection / quiet-zone heuristics, **RLE** summary. |
| **PNG metadata** | Reads **tEXt** / **zTXt** chunks (zlib) and runs the same “web-era” string checks on embedded strings. |
| **Crib** | Optional known substring: extra threshold / bundle workers, per-strategy scoring in logs, and **best-result** prefers **longest** decode among crib hits (else longest payload overall). |
| **Post-decode** | **GTIN/EAN/UPC** check-digit hints on unique payloads; **MD5**, **ROT0–25**, **ROT13**, **Atbash**, reverse, **Base64** / **hex** decode attempts, optional **Vigenère** (decrypt) when a crib is set. |
| **Console** | Live dashboard, or **`--plain`** / non-TTY for **append-only** output; live mode prints a **full transcript** after the run so scrollback is complete. |

---

## Requirements

- **Node.js ≥ 20**
- npm (or compatible client)

---

## Install

```bash
git clone <your-repo-url> BarcodeBasher
cd BarcodeBasher
npm install
npm run build
```

---

## Quick start

```bash
# Default image (repo: samples/voyage-barcode.png), build + run
npm run analyze

# Your image + session logs under ./logs
npm run analyze:fast -- path/to/barcode.png --log-dir logs

# Append-only console (nothing overwritten in the terminal)
npm run analyze:plain:fast -- path/to/barcode.png --log-dir logs

# Known plaintext hint (multi-word after --crib)
npm run analyze:fast -- img.png --log-dir logs --crib YOUR PHRASE HERE
```

Config-driven run (uses `package.json` → `config`):

```bash
npm run run
# or skip TypeScript if dist/ is fresh:
npm run run:fast
```

Override config without editing files:

```bash
npm pkg set config.bb_image=assets/mystery.png
npm pkg set config.bb_log_dir=out-logs
npm pkg set config.bb_crib="OTHER HINT"
npm pkg set config.bb_no_crib=true
```

---

## CLI

| Argument | Meaning |
|----------|---------|
| `<image.png>` | Image path (first non-flag argument). |
| `--log-dir <dir>` | Write `run-*.log` and `run-*.jsonl` under that directory. |
| `--crib <words…>` | Crib string (tokens until the next `--flag`). |
| `--no-crib` | Disable crib workers and crib scoring. |
| `--plain` | Append-only stdout (no live refresh). Also default when stdout is not a TTY. |

Environment:

- **`BARCODE_BASHER_PLAIN=1`** (or `true`) — force plain mode in a TTY.

Full script and flag reference:

```bash
npm run help
```

---

## Architecture (short)

- **`src/index.ts`** — CLI, job list, orchestration (parallel strategies + sequential exhaustive pass), crib scoring, log sections.
- **`src/orchestrator.ts`** — spawns `src/workers/strategyWorker.ts` per job.
- **`src/decode/`** — ZXing attempts, jsQR, javascript-barcode-reader wrappers, exhaustive Sharp+ZXing sweep.
- **`src/forensics.ts`** / **`src/image/`** — raster analysis, Otsu, local adaptive, PNG text chunks, BC simulations.
- **`src/logging/`** — `[DECODE_OUTPUT]`, JSONL events, payload checksum section, web-era sieve section.
- **`src/tui/dashboard.ts`** — Live UI + transcript + plain mode.

---

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | `tsc` (incremental; `.tsbuildinfo`). |
| `npm run build:clean` | Clean `dist/` + `.tsbuildinfo`, then compile. |
| `npm run build:watch` | Watch mode. |
| `npm run clean` | Remove `dist/`, `.tsbuildinfo`, `logs/`. |
| `npm run analyze` | Build + CLI with default image. |
| `npm run analyze:fast` | CLI only (skip build). |
| `npm run analyze:plain` | Build + `--plain`. |
| `npm run analyze:logs` / `:fast` | Sample image + `--log-dir logs`. |
| `npm run analyze:full` / `:fast` | Sample + logs + default crib. |
| `npm run analyze:no-crib` / `:fast` | Sample + logs + `--no-crib`. |
| `npm run decode` / `decode:*` | Aliases of the matching `analyze:*` scripts. |
| `npm run run` / `run:fast` | Build (or not) + `scripts/run-from-config.mjs`. |

Pass extra CLI args after `--`:

```bash
npm run run:fast -- ./img.png --log-dir D:/tmp --crib OTHER HINT
```

---

## Logs

With `--log-dir`, each session produces:

- **`.log`** — Forensics block, `[DECODE_OUTPUT]` per success, `[OK]`/`[FAIL]` summaries, optional `[CRIB]`, `[PAYLOAD_CHECKSUM]`, `[WEB_SIEVE]`, `[SUMMARY]`.
- **`.jsonl`** — Machine-readable lines (`session_start`, `forensics`, `decode_output`, `strategy_result`, `web_era_sieve`, etc.).

---

## Discord blurb (copy-paste)

A ready-to-post short description lives in **`DISCORD.md`** in this repo.

---

## Contributing / license

This project does not ship a root `LICENSE` file yet; add one if you open-source it. Dependencies retain their respective licenses (`@zxing/library`, `sharp`, `jsqr`, `javascript-barcode-reader`, etc.).

---

## Name

**Barcode Basher** — bash the image with every reasonable decoder + preprocess until something talks.
