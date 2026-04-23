#!/usr/bin/env node
/**
 * Runs dist/index.js using package.json "config", merged with npm-injected
 * npm_package_config_* when launched via npm run.
 *
 * Args after \`npm run … -- …\` replace the entire default argv (pass-through).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const cfg = pkg.config ?? {};

function cfgVal(key, fallback) {
  const envKey = `npm_package_config_${key}`;
  const v = process.env[envKey];
  if (v !== undefined && v !== '') return v;
  if (cfg[key] !== undefined && cfg[key] !== '') return cfg[key];
  return fallback;
}

const imageRel = cfgVal('bb_image', 'samples/voyage-barcode.png');
const logDirRel = cfgVal('bb_log_dir', 'logs');
const cribRaw = String(cfgVal('bb_crib', 'YOUR CHARM')).trim();
const noCribRaw = cfgVal('bb_no_crib', false);
const noCrib =
  noCribRaw === true ||
  noCribRaw === 'true' ||
  String(noCribRaw).toLowerCase() === 'true';

const image = path.resolve(root, imageRel);
const logDir = path.resolve(root, logDirRel);
const cribWords = cribRaw.split(/\s+/).filter(Boolean);

const defaultArgs = noCrib
  ? [image, '--log-dir', logDir, '--no-crib']
  : [image, '--log-dir', logDir, '--crib', ...cribWords];

const passthrough = process.argv.slice(2);
const finalArgs = passthrough.length ? passthrough : defaultArgs;

const entry = path.join(root, 'dist', 'index.js');
const child = spawn(process.execPath, [entry, ...finalArgs], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
