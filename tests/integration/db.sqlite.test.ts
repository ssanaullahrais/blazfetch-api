import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/types';

let db: Database;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blazfetch-db-'));
  process.env.DATABASE_DRIVER = 'sqlite';
  process.env.DATABASE_SQLITE_PATH = path.join(dir, 'test.sqlite3');
  db = (await import('../../src/db')).getDb();
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

  it('upserts and reads the metadata cache', async () => {
    const meta = { success: true, platform: 'youtube', title: 't', formats: [], audioFormats: [] } as never;
    await db.metadataCache.set('youtube', 'abc', 'https://y/abc', meta);
    await db.metadataCache.set('youtube', 'abc', 'https://y/abc', { ...(meta as object), title: 't2' } as never);
    expect((await db.metadataCache.get('youtube', 'abc'))?.title).toBe('t2');
    expect((await db.metadataCache.getByUrl('youtube', 'https://y/abc'))?.title).toBe('t2');
    expect(await db.metadataCache.get('youtube', 'nope')).toBeNull();
  });

  it('records fetch and download stats', async () => {
    await expect(db.stats.recordFetchStat({ platform: 'youtube', success: true } as never)).resolves.toBeUndefined();
    await expect(db.stats.recordDownloadStat({ platform: 'youtube', kind: 'video', success: true } as never)).resolves.toBeUndefined();
  });
});
