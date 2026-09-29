import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

vi.hoisted(async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blazfetch-direct-'));
  process.env.DATABASE_DRIVER = 'sqlite'; process.env.DATABASE_SQLITE_PATH = path.join(directory, 'audit.sqlite3');
  process.env.TEMP_DIR = path.join(directory, 'downloads'); process.env.LOG_LEVEL = 'silent';
});
vi.mock('../../src/utils/shortLinks', async () => ({ normalizeAndResolveUrl: (await import('../../src/utils/url')).validateAndNormalizeUrl }));
vi.mock('../../src/utils/url', async () => ({ ...await vi.importActual('../../src/utils/url'), assertUrlIsSafeToFetch: vi.fn(async () => undefined) }));
vi.mock('../../src/core/adapters/registry', () => ({ getAdapter: () => ({ download: async () => ({ filePath: '', directUrl: 'https://cdn.example/short-lived', filename: 'video.mp4', mimeType: 'video/mp4', bytes: 0 }) }) }));
vi.mock('../../src/services/fetchService', () => ({ fetchMedia: async () => ({ platform: 'youtube', mediaId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Video', formats: [{ formatId: 'cobalt-video', kind: 'video', ext: 'mp4' }], audioFormats: [] }) }));
vi.mock('../../src/utils/rangedFetch', () => ({ openRanged: vi.fn(async () => ({ stream: Readable.from([Buffer.from('prepared-media')]), totalBytes: 14 })) }));
vi.mock('../../src/core/ffmpeg/ffprobe', () => ({ validateMediaFile: vi.fn(async () => ({ durationSeconds: 1 })), isBrowserCompatibleMp4: () => true }));
vi.mock('../../src/services/statsService', () => ({ recordDownloadStat: vi.fn(async () => undefined) }));

import { getDb } from '../../src/db';
import { createJob } from '../../src/core/jobs/jobManager';
import { runDownloadJob } from '../../src/services/downloadService';
import { recordDownloadStat } from '../../src/services/statsService';

afterAll(async () => { await getDb().close(); });
it('retains bulk direct-source bytes and validates them without counting preparation as delivery', async () => {
  await getDb().migrate();
  const job = await createJob({ platform: 'youtube', mediaId: null, canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', requestedFormat: { formatId: 'cobalt-video', kind: 'video' }, guestId: 'audit' });
  const result = await runDownloadJob(job, 'audit', { persistDirect: true });
  expect(result.directUrl).toBeUndefined();
  expect(result.job.status).toBe('completed');
  expect(result.job.sourceUrl).toBeNull();
  expect(fs.readFileSync(result.filePath, 'utf8')).toBe('prepared-media');
  expect(path.basename(result.filePath)).toBe('prepared.mp4');
  expect(recordDownloadStat).not.toHaveBeenCalled();
});
