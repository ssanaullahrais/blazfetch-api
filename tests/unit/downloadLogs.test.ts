import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// vi.hoisted runs before the imports below, so the app's config really sees these values.
const dbFile = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'blazfetch-download-logs-'));
  process.env.DATABASE_DRIVER = 'sqlite';
  process.env.DATABASE_SQLITE_PATH = nodePath.join(dir, 'logs.sqlite3');
  process.env.LOG_LEVEL = 'silent';
  return process.env.DATABASE_SQLITE_PATH as string;
});

import { getDb } from '../../src/db';
import { getKnex, closeKnex } from '../../src/db/sql/knexClient';
import { beginAttempt, getMediaDownloadLogs, record } from '../../src/services/downloadLogs';

beforeAll(async () => {
  await getDb().migrate();
});

afterAll(async () => {
  await closeKnex();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe('downloadLogs (persisted, public)', () => {
  it('stores lines against an attempt and reads them back, with no ownership check', async () => {
    await beginAttempt({ requestId: 'r1', platform: 'youtube', mediaKey: 'abc123', guestId: 'guest-1' });
    await record('r1', 'warn', 'live streaming failed, preparing instead');
    await record('r1', 'info', 'download completed successfully.');

    const attempts = await getMediaDownloadLogs('youtube', 'abc123');
    expect(attempts).toHaveLength(1);
    expect(attempts?.[0].requestId).toBe('r1');
    expect(attempts?.[0].lines.map((l) => l.message)).toEqual([
      'live streaming failed, preparing instead',
      'download completed successfully.',
    ]);
  });

  it('is visible to anyone who asks for this media, not just the guest/user who started it', async () => {
    await beginAttempt({ requestId: 'r2', platform: 'youtube', mediaKey: 'other', guestId: 'guest-a' });
    await record('r2', 'info', 'hello');
    // No guestId/userId is passed at all — this no longer filters by who started the attempt.
    const attempts = await getMediaDownloadLogs('youtube', 'other');
    expect(attempts).toHaveLength(1);
    expect(attempts?.[0].lines.map((l) => l.message)).toEqual(['hello']);
  });

  it('is a no-op to record against a requestId that was never begun', async () => {
    await expect(record('never-registered', 'error', 'x')).resolves.toBeUndefined();
  });

  it('returns undefined for media nobody has ever attempted', async () => {
    expect(await getMediaDownloadLogs('youtube', 'never-seen-media')).toBeUndefined();
  });

  it('redacts anything that looks like an IPv4 or IPv6 address before storing a line', async () => {
    await beginAttempt({ requestId: 'r6', platform: 'youtube', mediaKey: 'ip-test', guestId: 'guest-ip' });
    await record('r6', 'warn', 'upstream refused (203.0.113.42) and again from 2001:db8::1');
    const attempts = await getMediaDownloadLogs('youtube', 'ip-test');
    expect(attempts?.[0].lines[0].message).toBe('upstream refused ([ip]) and again from [ip]');
  });

  it('returns the most recent attempt first, and keeps every attempt (not just the latest)', async () => {
    await beginAttempt({ requestId: 'r4', platform: 'youtube', mediaKey: 'multi', guestId: 'guest-multi' });
    await beginAttempt({ requestId: 'r5', platform: 'youtube', mediaKey: 'multi', guestId: 'guest-multi' });
    const attempts = await getMediaDownloadLogs('youtube', 'multi');
    expect(attempts?.map((a) => a.requestId)).toEqual(['r5', 'r4']);
  });

  it('is written straight to the database, not kept in process memory', async () => {
    await beginAttempt({ requestId: 'r7', platform: 'youtube', mediaKey: 'persisted', guestId: 'guest-7' });
    await record('r7', 'info', 'still here after a restart');
    const row = await getKnex()('download_log_lines').where({ request_id: 'r7' }).first();
    expect(row?.message).toBe('still here after a restart');
  });
});
