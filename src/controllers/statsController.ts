import { Request, Response } from 'express';
import { getStatsTotals, subscribeStatsTotals } from '../services/statsTotalsService';

/** Public, anonymous totals (no per-visitor data). */
export async function getStats(_req: Request, res: Response): Promise<void> {
  const totals = await getStatsTotals();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, ...totals });
}

/** Push committed totals immediately. Periodic reads also observe writes from other API workers. */
export function streamStats(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  let closed = false;
  let loading = false;
  let reload = false;
  let previous = '';
  const send = async (): Promise<void> => {
    if (closed) return;
    if (loading) { reload = true; return; }
    loading = true;
    try {
      const totals = await getStatsTotals();
      const data = JSON.stringify({ success: true, ...totals });
      if (!closed && data !== previous) {
        previous = data;
        res.write(`data: ${data}\n\n`);
      }
    } catch {
      // Keep the connection alive through a temporary database outage and retry on the next tick.
    } finally {
      loading = false;
      if (reload) { reload = false; void send(); }
    }
  };
  const unsubscribe = subscribeStatsTotals(() => { void send(); });
  const poll = setInterval(() => { void send(); }, 2_000);
  const heartbeat = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15_000);
  res.once('close', () => {
    closed = true;
    unsubscribe();
    clearInterval(poll);
    clearInterval(heartbeat);
  });
  void send();
}
