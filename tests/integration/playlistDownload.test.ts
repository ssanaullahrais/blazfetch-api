import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../../src/core/jobs/jobTypes';

vi.hoisted(async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blazfetch-playlist-test-'));
  process.env.DATABASE_DRIVER = 'sqlite'; process.env.DATABASE_SQLITE_PATH = path.join(dir, 'test.sqlite3');
  process.env.LOG_LEVEL = 'silent'; process.env.RATE_LIMIT_MAX_DOWNLOAD = '1000';
});
vi.mock('../../src/utils/shortLinks', async () => {
  const { validateAndNormalizeUrl } = await import('../../src/utils/url');
  return { normalizeAndResolveUrl: async (url: string) => validateAndNormalizeUrl(url) };
});
vi.mock('../../src/services/fetchService', () => ({ fetchMedia: vi.fn(async () => ({
  title: 'Test playlist', playlist: { items: [
    { videoId: 'dQw4w9WgXcQ', title: 'One', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { videoId: 'Cwkej79U3ek', title: 'Two', url: 'https://www.youtube.com/watch?v=Cwkej79U3ek' },
  ] },
})) }));

const runner = vi.hoisted(() => ({ active: 0, peak: 0, failSecond: false, hold: false }));
vi.mock('../../src/services/downloadService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/downloadService')>('../../src/services/downloadService');
  return { ...actual,
    resolveFormat: vi.fn(async (_url, _requestId, format) => ({ ...format, formatId: '18' })),
    runDownloadJob: vi.fn(async (job: JobRecord) => {
      const { getJobSignal, updateJobStatus } = await import('../../src/core/jobs/jobManager');
      const signal = getJobSignal(job.id);
      runner.active++; runner.peak = Math.max(runner.peak, runner.active);
      try {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) { reject(new Error('cancelled')); return; }
          if (!runner.hold) setTimeout(resolve, 25);
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
        if (runner.failSecond && job.canonicalUrl.includes('Cwkej79U3ek')) throw new Error('source failed');
        await updateJobStatus(job.id, 'ready', { source_url: 'https://cdn.example/video.mp4' });
      } finally { runner.active--; }
    }),
  };
});

import { createApp } from '../../src/app';
import { getDb } from '../../src/db';
import { fetchMedia } from '../../src/services/fetchService';
import { env } from '../../src/config/env';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server; let base: string;
const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest';
const headers = { 'content-type': 'application/json', cookie: 'blazfetch_guest_id=11111111-1111-4111-8111-111111111111' };
beforeAll(async () => {
  await getDb().migrate(); server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await getDb().close(); });
beforeEach(() => { runner.active = 0; runner.peak = 0; runner.failSecond = false; runner.hold = false; });

async function start(extra = {}) {
  const response = await fetch(`${base}/playlist/download`, { method: 'POST', headers, body: JSON.stringify({ url, ...extra }) });
  return { response, data: await response.json() as { job: { id: string; items: { id: string }[] } } };
}
async function status(id: string) {
  const response = await fetch(`${base}/playlist/downloads/${id}`, { headers });
  return (await response.json()).job;
}
async function terminal(id: string) {
  for (let i = 0; i < 100; i++) {
    const job = await status(id);
    if (['ready', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Playlist did not finish');
}

describe('bulk playlist HTTP workflow', () => {
  it('accepts watch+list URLs, persists child jobs, and prepares them within visitor limits', async () => {
    const { response, data } = await start();
    expect(response.status).toBe(202);
    const job = await terminal(data.job.id);
    expect(job).toMatchObject({ status: 'ready', total: 2, prepared: 2, failed: 0, progress: 100 });
    expect(runner.peak).toBe(1);
    const stored = await getDb().jobs.get(data.job.id);
    expect(stored.requestedFormat.playlist?.items).toHaveLength(2);
    expect(job.items.every((item: { downloadUrl: string }) => item.downloadUrl.startsWith('/api/v1/downloads/'))).toBe(true);
  });
  it('continues after one item fails and reports partial results', async () => {
    runner.failSecond = true;
    const { data } = await start();
    expect(await terminal(data.job.id)).toMatchObject({ status: 'ready', outcome: 'partial', prepared: 1, failed: 1, progress: 100 });
  });
  it('supports audio playlists and an explicit maximum number of items', async () => {
    const { data } = await start({ kind: 'audio', maxItems: 1 });
    expect(await terminal(data.job.id)).toMatchObject({ total: 1, prepared: 1 });
    expect((await getDb().jobs.get(data.job.items[0].id)).requestedFormat.kind).toBe('audio');
  });
  it('keeps the bulk preparation cap separate from the metadata listing limit', async () => {
    const limit = env.MAX_PLAYLIST_DOWNLOAD_ITEMS;
    try {
      env.MAX_PLAYLIST_DOWNLOAD_ITEMS = 1;
      const { data } = await start();
      expect(await terminal(data.job.id)).toMatchObject({ total: 1, prepared: 1 });
    } finally { env.MAX_PLAYLIST_DOWNLOAD_ITEMS = limit; }
  });
  it('hides another visitor’s playlist job', async () => {
    const { data } = await start(); await terminal(data.job.id);
    const response = await fetch(`${base}/playlist/downloads/${data.job.id}`, { headers: { cookie: 'blazfetch_guest_id=22222222-2222-4222-8222-222222222222' } });
    expect(response.status).toBe(404);
  });
  it('cancels active and queued items and releases the visitor slot', async () => {
    runner.hold = true;
    const { data } = await start();
    for (let i = 0; !runner.active && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const response = await fetch(`${base}/playlist/downloads/${data.job.id}`, { method: 'DELETE', headers });
    expect(response.status).toBe(200);
    expect(await terminal(data.job.id)).toMatchObject({ status: 'cancelled', failed: 2 });
    for (let i = 0; runner.active && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    runner.hold = false;
    const next = await start(); expect(next.response.status).toBe(202); await terminal(next.data.job.id);
  });
  it('rejects non-playlists without creating a bulk job', async () => {
    const response = await fetch(`${base}/playlist/download`, { method: 'POST', headers, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }) });
    expect(response.status).toBe(400);
  });
  it('rejects unsafe item URLs from an upstream listing and releases reserved slots', async () => {
    vi.mocked(fetchMedia).mockResolvedValueOnce({ playlist: { items: [{ title: 'bad', url: 'http://127.0.0.1/private' }] } } as never);
    const response = await start(); expect(response.response.status).toBe(422);
    const next = await start(); expect(next.response.status).toBe(202); await terminal(next.data.job.id);
  });
  it('does not permit a playlist to consume more than the guest concurrency allowance', async () => {
    const old = env.PLAYLIST_DOWNLOAD_CONCURRENCY; env.PLAYLIST_DOWNLOAD_CONCURRENCY = 4;
    try { const { data } = await start(); await terminal(data.job.id); expect(runner.peak).toBe(1); }
    finally { env.PLAYLIST_DOWNLOAD_CONCURRENCY = old; }
  });
});
