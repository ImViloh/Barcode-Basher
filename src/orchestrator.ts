import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StrategyJob, StrategyWorkerResult } from './types.js';

const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workers', 'strategyWorker.js');

export function runStrategy(imagePath: string, job: StrategyJob): Promise<StrategyWorkerResult> {
  const payload: StrategyJob = { ...job, imagePath };
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerFile, { workerData: payload });
    worker.once('message', (msg: StrategyWorkerResult) => {
      settled = true;
      resolve(msg);
    });
    worker.once('error', (err) => {
      if (!settled) reject(err);
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`Worker exited early with code ${code}`));
      }
    });
  });
}
