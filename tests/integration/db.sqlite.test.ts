import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// vi.hoisted runs before the imports, so the app's config really sees the temporary database path.
const dir = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'blazfetch-db-'));
  process.env.DATABASE_DRIVER = 'sqlite';
  process.env.DATABASE_SQLITE_PATH = nodePath.join(tmp, 'test.sqlite3');
  process.env.LOG_LEVEL = 'silent';
  return tmp;
});

import { getDb } from '../../src/db';
import type { Database } from '../../src/db/types';
import { getKnex } from '../../src/db/sql/knexClient';

let db: Database;

beforeAll(async () => {
  db = getDb();
  await db.migrate();
});

afterAll(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sqlite database driver', () => {
  it('migrates idempotently and reports a healthy connection', async () => {
    await expect(db.migrate()).resolves.toBeUndefined();
    expect(await db.checkConnection()).toBe(true);
  });

  it('creates, updates and reads jobs with correct UTC timestamps', async () => {
    const before = Date.now();
    const job = await db.jobs.create({ platform: 'youtube', mediaId: 'abc', canonicalUrl: 'https://y/abc', requestedFormat: { formatId: 'best' } as never });
    await db.jobs.updateStatus(job.id, 'processing', { temp_path: '/tmp/x' });
    await db.jobs.updateProgress(job.id, 5_000_000_000, 6_000_000_000, 83.4);
    const got = await db.jobs.get(job.id);
    expect(got.status).toBe('processing');
    expect(got.tempPath).toBe('/tmp/x');
    expect(got.progress).toBe(83);
    expect(got.downloadedBytes).toBe(5_000_000_000);
    expect(Math.abs(new Date(got.createdAt).getTime() - before)).toBeLessThan(60_000);
  });

  it('throws JOB_NOT_FOUND for an unknown job', async () => {
    await expect(db.jobs.get('missing')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });

  it('stores media permanently: upsert keeps counters and first_fetched_at, lookups work by key and by URL', async () => {
    const meta = { success: true, platform: 'youtube', mediaId: 'abc', mediaType: 'video', canonicalUrl: 'https://y/abc', title: 't', formats: [], audioFormats: [], extractor: 'yt-dlp' } as never;
    const input = { platform: 'youtube', mediaKey: 'abc', canonicalUrl: 'https://y/abc', sourceUrl: 'https://y/abc?x=1', path: '/youtube/abc', isPublic: true, urlsExpireAt: new Date(Date.now() + 3600_000), nextCheckAt: new Date(Date.now() + 7 * 86400_000) };
    await db.metadataCache.upsert({ ...input, metadata: meta });
    await db.metadataCache.recordAccess('youtube', 'abc', 'hit');
    await db.metadataCache.upsert({ ...input, metadata: { ...(meta as object), title: 't2' } as never });

    const byKey = await db.metadataCache.findByKey('youtube', 'abc');
    expect(byKey?.metadata.title).toBe('t2');
    expect(byKey).toMatchObject({ kind: 'video', sourceUrl: 'https://y/abc?x=1', path: '/youtube/abc', status: 'available', isPublic: true });
    expect(byKey?.counters).toMatchObject({ fetchCount: 2, hitCount: 1 });
    expect((await db.metadataCache.findByUrl('youtube', 'https://y/abc'))?.metadata.title).toBe('t2');
    expect(await db.metadataCache.findByKey('youtube', 'nope')).toBeNull();
  });

  it('migrations are versioned and idempotent', async () => {
    await db.migrate();
    await db.migrate();
    const versions = (await getKnex()('schema_migrations').select('version').orderBy('version')).map((r: { version: number }) => r.version);
    expect(versions).toEqual([1, 2, 3]);
  });

  it('records fetch and download stats', async () => {
    await expect(db.stats.recordFetchStat({ platform: 'youtube', success: true } as never)).resolves.toBeUndefined();
    await expect(db.stats.recordDownloadStat({ platform: 'youtube', kind: 'video', success: true } as never)).resolves.toBeUndefined();
  });
});
