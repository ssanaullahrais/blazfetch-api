import { getDb } from '../db';
import type { StatsTotals } from '../db/types';

const CACHE_MS = 60_000;
let cached: { at: number; value: StatsTotals } | null = null;

/** All-time totals for the public counter. Cached for a minute so a busy page never turns into a COUNT(*) per visitor. */
export async function getStatsTotals(now = Date.now()): Promise<StatsTotals> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = await getDb().stats.totals();
  cached = { at: now, value };
  return value;
}

export function resetStatsTotalsCache(): void {
  cached = null;
}
