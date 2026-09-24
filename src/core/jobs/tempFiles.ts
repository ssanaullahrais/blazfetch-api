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
    await fs.promises.rm(dir, { recursive: true, force: true });
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
