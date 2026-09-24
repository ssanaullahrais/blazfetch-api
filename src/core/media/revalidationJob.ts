import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { getDb } from '../../db';
import { revalidateStored } from '../../services/fetchService';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RevalidationSummary {
  checked: number;
  available: number;
  unavailable: number;
  failed: number;
  skipped: number;
}

let running = false;

/**
 * Re-checks the stored items whose weekly existence check is due, oldest first. Checks run one at a
 * time with a pause between them, so a large backlog never hammers the source sites, and a newly
 * deleted or private video is noticed (and marked unavailable) without anyone having to request it.
 */
export async function runRevalidationBatch(limit: number = env.REVALIDATE_BATCH_SIZE, delayMs: number = env.REVALIDATE_DELAY_MS): Promise<RevalidationSummary> {
  const summary: RevalidationSummary = { checked: 0, available: 0, unavailable: 0, failed: 0, skipped: 0 };
  if (running) return summary; // a previous batch is still going (slow sites); don't overlap
  running = true;
  try {
    const due = await getDb().metadataCache.listDue(new Date(), limit);
    for (const [index, record] of due.entries()) {
      const outcome = await revalidateStored(record, `revalidate-${uuidv4()}`);
      summary.checked += 1;
      summary[outcome] += 1;
      if (index < due.length - 1 && outcome !== 'skipped') await sleep(delayMs);
    }
    if (summary.checked > 0) logger.info(summary, 'revalidation batch finished');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'revalidation batch failed');
  } finally {
    running = false;
  }
  return summary;
}

/** Starts the periodic background job (disable with REVALIDATE_ENABLED=false). Returns a stop function. */
export function startRevalidationJob(): () => void {
  if (!env.REVALIDATE_ENABLED) {
    logger.info('background revalidation is disabled');
    return () => undefined;
  }
  const timer = setInterval(() => void runRevalidationBatch(), env.REVALIDATE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
