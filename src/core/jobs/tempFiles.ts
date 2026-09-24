import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

export function jobTempDir(jobId: string): string {
  return path.join(env.TEMP_DIR, jobId);
}

export async function cleanupJobTempDir(jobId: string): Promise<void> {
  const dir = jobTempDir(jobId);
  try {
    // Retries cover Windows briefly holding a file open right after its process was killed.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    logger.warn({ jobId, err }, 'failed to clean up temp dir');
  }
}

/** Removes temp job directories left behind by a crash or unclean restart. Runs at startup. */
export async function cleanupAbandonedTempDirs(maxAgeMs = 1000 * 60 * 60 * 6): Promise<void> {
  try {
    await fs.promises.mkdir(env.TEMP_DIR, { recursive: true });
    const entries = await fs.promises.readdir(env.TEMP_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(env.TEMP_DIR, entry.name);
      const stat = await fs.promises.stat(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
        logger.info({ path: fullPath }, 'removed abandoned temp directory');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'temp dir cleanup scan failed');
  }
}

/**
 * Deletes anything in TEMP_DIR (files and folders) older than `maxAgeMs`. This is the safety net
 * for leftovers no request ever came back for, e.g. a finished job whose file was never downloaded.
 */
export async function sweepTempDir(maxAgeMs: number = env.TEMP_SWEEP_MAX_AGE_MS): Promise<number> {
  let removed = 0;
  try {
    await fs.promises.mkdir(env.TEMP_DIR, { recursive: true });
    const entries = await fs.promises.readdir(env.TEMP_DIR);
    const now = Date.now();
    for (const name of entries) {
      const fullPath = path.join(env.TEMP_DIR, name);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
          removed += 1;
          logger.info({ path: fullPath }, 'swept old temp entry');
        }
      } catch (err) {
        logger.warn({ path: fullPath, err: (err as Error).message }, 'could not sweep temp entry');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'temp dir sweep failed');
  }
  return removed;
}

/** Runs sweepTempDir on a timer for the life of the process. Returns a function that stops it. */
export function startTempSweeper(intervalMs: number = env.TEMP_SWEEP_INTERVAL_MS): () => void {
  const timer = setInterval(() => void sweepTempDir(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
