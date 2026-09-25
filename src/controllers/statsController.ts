import { Request, Response } from 'express';
import { ErrorCode } from '../constants/errors';
import { networkKey } from '../utils/clientKey';
import { getStatsTotals, subscribeStatsTotals } from '../services/statsTotalsService';

/** Public, anonymous totals (no per-visitor data). */
export async function getStats(_req: Request, res: Response): Promise<void> {
  const totals = await getStatsTotals();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, ...totals });
}

const MAX_STREAMS_PER_CLIENT = 5;
const MAX_STREAMS_TOTAL = 1000;
const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;

/**
 * Every open /stats/events connection shares ONE poller, so the database sees one query per tick no matter how many
 * pages are open (one query per connection per tick let anyone load the database just by holding connections open).
 */
const subscribers = new Set<Response>();
const streamsPerClient = new Map<string, number>();
let latest = '';
let loading = false;
let reload = false;
let stopPolling: (() => void) | undefined;

async function broadcast(): Promise<void> {
  if (subscribers.size === 0) return;
  if (loading) { reload = true; return; }
  loading = true;
  try {
    const data = JSON.stringify({ success: true, ...(await getStatsTotals()) });
    if (data !== latest) {
      latest = data;
      for (const res of subscribers) res.write(`data: ${data}\n\n`);
    }
  } catch {
    // Keep the connections alive through a temporary database outage and retry on the next tick.
  } finally {
    loading = false;
    if (reload) { reload = false; void broadcast(); }
  }
}

function startPolling(): void {
  if (stopPolling) return;
  const unsubscribe = subscribeStatsTotals(() => { void broadcast(); });
  const poll = setInterval(() => { void broadcast(); }, POLL_MS);
  const heartbeat = setInterval(() => { for (const res of subscribers) res.write(': keep-alive\n\n'); }, HEARTBEAT_MS);
  stopPolling = () => {
    unsubscribe();
    clearInterval(poll);
    clearInterval(heartbeat);
    stopPolling = undefined;
    latest = '';
  };
}

/** Push committed totals immediately. Periodic reads also observe writes from other API workers. */
export function streamStats(req: Request, res: Response): void {
  // No per-client cap when the address is the proxy's (see networkKey): every visitor would share it.
  const key = networkKey(req);
  const open = key ? streamsPerClient.get(key) ?? 0 : 0;
  if (open >= MAX_STREAMS_PER_CLIENT || subscribers.size >= MAX_STREAMS_TOTAL) {
    res.status(429).json({ success: false, error: { code: ErrorCode.SERVER_BUSY, message: 'Too many live stats connections.' }, requestId: req.requestId });
    return;
  }
  if (key) streamsPerClient.set(key, open + 1);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  if (latest) res.write(`data: ${latest}\n\n`);

  subscribers.add(res);
  startPolling();
  res.once('close', () => {
    subscribers.delete(res);
    if (key) {
      const left = (streamsPerClient.get(key) ?? 1) - 1;
      if (left <= 0) streamsPerClient.delete(key);
      else streamsPerClient.set(key, left);
    }
    if (subscribers.size === 0) stopPolling?.();
  });
  if (!latest) void broadcast();
}
