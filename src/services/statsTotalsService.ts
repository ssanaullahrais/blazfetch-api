import { getDb } from '../db';
import type { StatsTotals } from '../db/types';

const CACHE_MS = 1_000;
let cached: { at: number; value: StatsTotals } | null = null;
let generation = 0;
let pending: Promise<StatsTotals> | null = null;
const listeners = new Set<() => void>();

export function subscribeStatsTotals(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** All-time totals for the public counter. Cached for a few seconds so a busy page never turns into a COUNT(*) per visitor. */
export async function getStatsTotals(now = Date.now()): Promise<StatsTotals> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  if (pending) return pending;
  const startedGeneration = generation;
  const query = getDb().stats.totals().then((value) => {
    // A write committed while the count was running: do not publish that older snapshot.
    if (startedGeneration !== generation) return getStatsTotals();
    cached = { at: now, value };
    return value;
  });
  pending = query;
  try {
    return await query;
  } finally {
    if (pending === query) pending = null;
  }
}

export function resetStatsTotalsCache(): void {
  generation += 1;
  cached = null;
  pending = null;
  for (const listener of listeners) listener();
}
