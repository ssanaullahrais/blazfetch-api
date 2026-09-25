import { getDb } from '../db';
import { logger } from '../lib/logger';

const PRUNE_INTERVAL_MS = 600_000; // 10 minutes, same cadence as the temp-file sweep
const PRUNE_OLDER_THAN_MS = 3_600_000; // generous margin past ONLINE_VISITOR_WINDOW_SECONDS (default 60s):
// totals() never looks back this far, so anything older is dead weight, never a live visitor being missed.

/** Deletes visitor_presence rows old enough that no online-count window could ever count them again.
 * Pure housekeeping (keeps the table from growing forever on SQL); Mongo already self-cleans via its TTL
 * index, so this mostly no-ops there, but the call is harmless either way. */
async function sweepPresence(): Promise<void> {
  try {
    await getDb().stats.prunePresence(PRUNE_OLDER_THAN_MS);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'presence sweep failed');
  }
}

/** Runs sweepPresence on a timer for the life of the process. Returns a function that stops it. */
export function startPresenceSweeper(intervalMs: number = PRUNE_INTERVAL_MS): () => void {
  const timer = setInterval(() => void sweepPresence(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
