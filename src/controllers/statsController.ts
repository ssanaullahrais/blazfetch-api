import { Request, Response } from 'express';
import { ErrorCode } from '../constants/errors';
import { networkKey } from '../utils/clientKey';
import { getDb } from '../db';
import { logger } from '../lib/logger';
import { getStatsTotals, subscribeStatsTotals } from '../services/statsTotalsService';

function visitorId(req: Request): string {
  return req.userId ?? req.guestId ?? 'anonymous';
}

/** Best-effort: a visitor still gets their stats even if the presence write fails. */
function touchPresence(id: string): void {
  getDb().stats.recordPresence(id).catch((err) => logger.warn({ err: (err as Error).message }, 'failed to record visitor presence'));
}

/** Public, anonymous totals (no per-visitor data). Also counts as presence: the EventSource fallback
 * (see watchSiteStats on the frontend) polls this same endpoint when a live connection isn't available. */
export async function getStats(req: Request, res: Response): Promise<void> {
  touchPresence(visitorId(req));
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
 * Maps each open response to the visitor id it belongs to, so presence can be re-touched on every heartbeat without
 * a second lookup — this is also what the public "online now" count (see ONLINE_VISITOR_WINDOW_SECONDS) is built on.
 */
const subscribers = new Map<Response, string>();
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
      for (const res of subscribers.keys()) res.write(`data: ${data}\n\n`);
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
  // The same tick that keeps the connection alive also keeps its visitor "online": as long as a tab stays
  // open, this refreshes last_seen_at well inside ONLINE_VISITOR_WINDOW_SECONDS every time.
  const heartbeat = setInterval(() => {
    for (const [res, id] of subscribers) {
      res.write(': keep-alive\n\n');
      touchPresence(id);
    }
  }, HEARTBEAT_MS);
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

  touchPresence(visitorId(req));
  subscribers.set(res, visitorId(req));
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
