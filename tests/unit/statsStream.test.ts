import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getStatsTotals = vi.fn(async () => ({ fetches: 1 }));
vi.mock('../../src/services/statsTotalsService', () => ({
  getStatsTotals: () => getStatsTotals(),
  subscribeStatsTotals: () => () => undefined,
}));

const { streamStats } = await import('../../src/controllers/statsController');

function open(ip: string) {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    status(code: number) { this.statusCode = code; return this; },
    json: vi.fn(),
  });
  streamStats({ ip, headers: {}, requestId: 'r' } as never, res as never);
  return res;
}

describe('GET /stats/events', () => {
  afterEach(() => vi.useRealTimers());

  it('uses one database poll for all open connections', async () => {
    vi.useFakeTimers();
    const conns = Array.from({ length: 20 }, (_, i) => open(`198.51.100.${i}`));
    await vi.advanceTimersByTimeAsync(0);
    getStatsTotals.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getStatsTotals).toHaveBeenCalledTimes(1);
    conns.forEach((c) => c.emit('close'));
  });

  it('refuses more than a few connections from one client', () => {
    const conns = Array.from({ length: 5 }, () => open('203.0.113.5'));
    const extra = open('203.0.113.5');
    expect(extra.statusCode).toBe(429);
    expect(open('203.0.113.6').statusCode).toBe(200);
    conns.forEach((c) => c.emit('close'));
    expect(open('203.0.113.5').statusCode).toBe(200); // slots come back when connections close
  });
});
