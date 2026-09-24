import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted runs before the imports below, so the app's config really sees these values.
const dbFile = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'blazfetch-store-'));
  process.env.DATABASE_DRIVER = 'sqlite';
  process.env.DATABASE_SQLITE_PATH = nodePath.join(dir, 'store.sqlite3');
  process.env.TEMP_DIR = nodePath.join(dir, 'tmp');
  process.env.LOG_LEVEL = 'silent';
  process.env.RATE_LIMIT_MAX_GUEST = '1000';
  return process.env.DATABASE_SQLITE_PATH as string;
});

/** What the fake source does the next time it is asked. */
let sourceBehaviour: (url: string) => Promise<Record<string, unknown>>;
let sourceCalls = 0;

vi.mock('../../src/core/adapters/registry', () => ({
  getAdapter: () => ({
    platform: 'youtube',
    supports: () => true,
    fetchMetadata: async (ctx: { normalizedUrl: { canonicalUrl: string } }) => {
      sourceCalls += 1;
      return sourceBehaviour(ctx.normalizedUrl.canonicalUrl);
    },
    download: async () => {
      throw new Error('not used');
    },
  }),
}));

import { createApp } from '../../src/app';
import { BlazfetchError } from '../../src/constants/errors';
import { getDb } from '../../src/db';
import { getKnex } from '../../src/db/sql/knexClient';
import { fetchMedia, revalidateStored } from '../../src/services/fetchService';
import { runRevalidationBatch } from '../../src/core/media/revalidationJob';

const VIDEO_URL = 'https://www.youtube.com/watch?v=abc123';
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL1';

function video(id: string, title = 'A video'): Record<string, unknown> {
  return {
    success: true,
    platform: 'youtube',
    mediaType: 'video',
    mediaId: id,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    title,
    thumbnail: 'https://img.example/t.jpg',
    durationSeconds: 212,
    author: { name: 'Someone' },
    formats: [{ formatId: '18', ext: 'mp4', kind: 'video', url: 'https://cdn.example/18.mp4' }],
    audioFormats: [],
    metadata: {},
    extractor: 'yt-dlp',
  };
}

function playlist(id: string): Record<string, unknown> {
  return {
    success: true,
    platform: 'youtube',
    mediaType: 'playlist',
    isPlaylist: true,
    mediaId: id,
    canonicalUrl: `https://www.youtube.com/playlist?list=${id}`,
    title: 'A playlist',
    formats: [],
    audioFormats: [],
    playlist: { title: 'A playlist', itemCount: 1, items: [{ videoId: 'abc123', title: 'A video', url: VIDEO_URL }] },
    metadata: {},
    extractor: 'yt-dlp',
  };
}

const notFound = (): never => {
  throw new BlazfetchError('MEDIA_NOT_FOUND', 'gone');
};

const params = { requestId: 'test' };
const row = (key: string) => getKnex()('metadata_cache').where({ platform: 'youtube', media_id: key }).first();
const setRow = (key: string, values: Record<string, unknown>) => getKnex()('metadata_cache').where({ platform: 'youtube', media_id: key }).update(values);
const inPast = (ms = 60_000): Date => new Date(Date.now() - ms);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));

let server: http.Server;
let port: number;

beforeAll(async () => {
  await getDb().migrate();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await getDb().close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

beforeEach(async () => {
  sourceCalls = 0;
  sourceBehaviour = async (url) => (url.includes('/playlist') ? playlist(new URL(url).searchParams.get('list') as string) : video(new URL(url).searchParams.get('v') as string));
  await getKnex()('metadata_cache').del();
});

describe('media store: fetch', () => {
  it('extracts once, stores everything, then answers from the database', async () => {
    const first = await fetchMedia({ ...params, url: VIDEO_URL });
    expect(sourceCalls).toBe(1);
    expect(first.stored).toMatchObject({ path: '/youtube/abc123', cached: false, status: 'available', sourceUrl: VIDEO_URL });

    const second = await fetchMedia({ ...params, url: VIDEO_URL });
    expect(sourceCalls).toBe(1); // no second extraction
    expect(second.stored).toMatchObject({ cached: true, path: '/youtube/abc123' });
    expect(second.title).toBe('A video');
    expect(second.formats[0].url).toBe('https://cdn.example/18.mp4');

    const stored = await row('abc123');
    expect(stored).toMatchObject({ kind: 'video', title: 'A video', author_name: 'Someone', duration_seconds: 212, extractor: 'yt-dlp', is_public: 1, status: 'available' });
    expect(stored.fetch_count).toBe(1);
    await settle();
    expect((await row('abc123')).hit_count).toBe(1);
  });

  it('is found by its id even when the URL differs (same video, extra parameters)', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await fetchMedia({ ...params, url: 'https://youtu.be/abc123' });
    expect(sourceCalls).toBe(1);
  });

  it('keeps first_fetched_at and every counter when a refresh replaces the stored answer', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await settle();
    const before = await row('abc123');
    sourceBehaviour = async () => video('abc123', 'Renamed');
    const refreshed = await fetchMedia({ ...params, url: VIDEO_URL, forceRefresh: true });
    expect(refreshed.title).toBe('Renamed');
    const after = await row('abc123');
    expect(after.fetch_count).toBe(2);
    expect(new Date(after.first_fetched_at).getTime()).toBe(new Date(before.first_fetched_at).getTime());
  });

  it('stores playlists under playlist:<id> with their own path, and gives the in-context path for v=&list=', async () => {
    const list = await fetchMedia({ ...params, url: PLAYLIST_URL });
    expect(list.stored?.path).toBe('/youtube/playlist/PL1');
    expect((await row('playlist:PL1')).kind).toBe('playlist');

    const withContext = await fetchMedia({ ...params, url: `${VIDEO_URL}&list=PL1` });
    expect(withContext.stored?.path).toBe('/youtube/abc123');
    expect(withContext.stored?.playlistPath).toBe('/youtube/abc123/playlist/PL1');
  });

  it('never stores or serves ranged (partial collection) requests', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL, range: { start: 1, end: 2 } });
    expect(await row('abc123')).toBeUndefined();
  });

  it('does not treat results obtained with the operator login as public', async () => {
    const original = process.env.INSTAGRAM_COOKIES_PATH;
    const { env } = await import('../../src/config/env');
    const previous = env.INSTAGRAM_COOKIES_PATH;
    (env as { INSTAGRAM_COOKIES_PATH: string }).INSTAGRAM_COOKIES_PATH = 'C:/cookies.txt';
    try {
      const { isPublicSource } = await import('../../src/services/fetchService');
      expect(isPublicSource('instagram')).toBe(false);
      expect(isPublicSource('youtube')).toBe(true);
    } finally {
      (env as { INSTAGRAM_COOKIES_PATH: string }).INSTAGRAM_COOKIES_PATH = previous;
      if (original !== undefined) process.env.INSTAGRAM_COOKIES_PATH = original;
    }
  });
});

describe('media store: freshness of the direct media URLs', () => {
  it('serves stale URLs immediately and refreshes them in the background', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await setRow('abc123', { expires_at: inPast() });
    sourceBehaviour = async () => ({ ...video('abc123'), formats: [{ formatId: '18', ext: 'mp4', kind: 'video', url: 'https://cdn.example/NEW.mp4' }] });

    const answer = await fetchMedia({ ...params, url: VIDEO_URL });
    expect(answer.stored).toMatchObject({ cached: true, urlsStale: true });
    expect(answer.formats[0].url).toBe('https://cdn.example/18.mp4'); // the old answer, instantly

    await settle();
    expect(sourceCalls).toBe(2);
    expect((await fetchMedia({ ...params, url: VIDEO_URL })).formats[0].url).toBe('https://cdn.example/NEW.mp4');
  });

  it('re-extracts before answering when the caller needs fresh URLs (GET /stream)', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await setRow('abc123', { expires_at: inPast() });
    const answer = await fetchMedia({ ...params, url: VIDEO_URL, requireFreshUrls: true });
    expect(sourceCalls).toBe(2);
    expect(answer.stored?.cached).toBe(false);
  });

  it('trusts the direct links from a fallback provider only briefly, since they die within a minute', async () => {
    sourceBehaviour = async () => ({ ...video('abc123'), extractor: 'btch-downloader', fallbackUsed: 'btch-downloader' });
    await fetchMedia({ ...params, url: VIDEO_URL });
    const stored = await row('abc123');
    expect(new Date(stored.expires_at).getTime() - Date.now()).toBeLessThan(31_000);

    // a stream asks for fresh URLs, so it never reuses that stored link once it is past its short window
    await setRow('abc123', { expires_at: inPast(1000) });
    await fetchMedia({ ...params, url: VIDEO_URL, requireFreshUrls: true });
    expect(sourceCalls).toBe(2);
  });

  it('extracts a burst of simultaneous requests for one item only once', async () => {
    let release: () => void = () => undefined;
    sourceBehaviour = () => new Promise((resolve) => (release = () => resolve(video('abc123'))));
    const burst = Promise.all([1, 2, 3].map(() => fetchMedia({ ...params, url: VIDEO_URL })));
    await settle();
    release();
    await burst;
    expect(sourceCalls).toBe(1);
  });
});

describe('media store: weekly revalidation and unavailable media', () => {
  it('schedules the next existence check a week out', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    const next = new Date((await row('abc123')).next_check_at).getTime();
    expect(next - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(next - Date.now()).toBeLessThan(7.1 * 24 * 3600 * 1000);
  });

  it('re-checks on demand when the weekly check is due, and refreshes the stored answer', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await setRow('abc123', { next_check_at: inPast() });
    sourceBehaviour = async () => video('abc123', 'Updated title');
    const answer = await fetchMedia({ ...params, url: VIDEO_URL });
    expect(sourceCalls).toBe(2);
    expect(answer.title).toBe('Updated title');
  });

  it('one "not found" answer is not enough: the stored answer is still served, flagged', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await setRow('abc123', { next_check_at: inPast() });
    sourceBehaviour = async () => notFound();

    const answer = await fetchMedia({ ...params, url: VIDEO_URL });
    expect(answer.stored).toMatchObject({ cached: true, validationFailed: true, status: 'available' });
    const stored = await row('abc123');
    expect(stored).toMatchObject({ status: 'available', check_fail_count: 1 });
    // retried tomorrow, not next week
    expect(new Date(stored.next_check_at).getTime() - Date.now()).toBeLessThan(25 * 3600 * 1000);
  });

  it('a second consecutive "not found" marks it unavailable and answers 410 with a tombstone', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    sourceBehaviour = async () => notFound();
    await setRow('abc123', { next_check_at: inPast() });
    await fetchMedia({ ...params, url: VIDEO_URL }); // 1st failure, still served
    await setRow('abc123', { next_check_at: inPast() });

    const error = await fetchMedia({ ...params, url: VIDEO_URL }).catch((e) => e);
    expect(error).toBeInstanceOf(BlazfetchError);
    expect(error).toMatchObject({ code: 'MEDIA_UNAVAILABLE', status: 410 });
    expect(error.details.tombstone).toMatchObject({ title: 'A video', reason: 'MEDIA_NOT_FOUND', path: '/youtube/abc123' });
    expect(await row('abc123')).toMatchObject({ status: 'unavailable', unavailable_reason: 'MEDIA_NOT_FOUND' });
  });

  it('does not hammer the source for a known-unavailable item, and recovers if it comes back', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await setRow('abc123', { status: 'unavailable', unavailable_reason: 'MEDIA_NOT_FOUND', unavailable_since: inPast(), last_check_at: new Date() });
    sourceCalls = 0;
    await expect(fetchMedia({ ...params, url: VIDEO_URL })).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
    expect(sourceCalls).toBe(0); // checked moments ago: answered from the tombstone

    await setRow('abc123', { last_check_at: inPast(3600_000) });
    const back = await fetchMedia({ ...params, url: VIDEO_URL });
    expect(sourceCalls).toBe(1);
    expect(back.stored).toMatchObject({ status: 'available', cached: false });
    expect(await row('abc123')).toMatchObject({ status: 'available', check_fail_count: 0, unavailable_reason: null });
  });

  it('timeouts and rate limits never count towards "unavailable"', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    for (let i = 0; i < 4; i++) {
      await setRow('abc123', { next_check_at: inPast() });
      sourceBehaviour = async () => {
        throw new BlazfetchError('PROCESS_TIMEOUT', 'slow');
      };
      const answer = await fetchMedia({ ...params, url: VIDEO_URL });
      expect(answer.stored?.validationFailed).toBe(true);
    }
    expect(await row('abc123')).toMatchObject({ status: 'available', check_fail_count: 0 });
  });

  it('the background job checks due items, marks the gone ones, and skips login-only rows', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await fetchMedia({ ...params, url: 'https://www.youtube.com/watch?v=gone1' });
    await fetchMedia({ ...params, url: 'https://www.youtube.com/watch?v=private1' });
    await setRow('private1', { is_public: false });
    await Promise.all(['abc123', 'gone1', 'private1'].map((k) => setRow(k, { next_check_at: inPast(), check_fail_count: k === 'gone1' ? 1 : 0 })));

    sourceCalls = 0;
    sourceBehaviour = async (url) => (url.includes('gone1') ? notFound() : video('abc123'));
    const summary = await runRevalidationBatch(10, 0);

    expect(summary).toMatchObject({ checked: 3, available: 1, unavailable: 1, skipped: 1 });
    expect(sourceCalls).toBe(2); // the login-only row was never re-extracted
    expect(await row('gone1')).toMatchObject({ status: 'unavailable' });
    expect(await row('abc123')).toMatchObject({ status: 'available' });
    expect(new Date((await row('abc123')).next_check_at).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
  });

  it('revalidateStored records a transient failure without changing availability', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    const record = (await getDb().metadataCache.findByKey('youtube', 'abc123'))!;
    sourceBehaviour = async () => {
      throw new BlazfetchError('PLATFORM_RATE_LIMITED', 'slow down');
    };
    expect(await revalidateStored(record, 'r1')).toBe('failed');
    expect(await row('abc123')).toMatchObject({ status: 'available' });
  });
});

describe('media store: statistics counters', () => {
  it('counts downloads per mode and the bytes served', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    const store = getDb().metadataCache;
    await store.recordDownload('youtube', 'abc123', { mode: 'stream', bytes: 1000 });
    await store.recordDownload('youtube', 'abc123', { mode: 'prepare', bytes: 500 });
    const stored = await row('abc123');
    expect(stored).toMatchObject({ download_count: 2, stream_count: 1, prepare_count: 1, bytes_served: 1500 });
    expect(stored.last_downloaded_at).toBeTruthy();
  });
});

describe('GET /api/v1/media/*', () => {
  function get(pathAndQuery: string, guest = `g-${Math.random()}`): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      http
        .get({ port, path: pathAndQuery, headers: { cookie: `blazfetch_guest_id=${guest}` }, agent: false }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(body) }));
        })
        .on('error', reject);
    });
  }

  it('serves a stored item by its stable path with its statistics, and counts the view', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    sourceCalls = 0;
    const { status, json } = await get('/api/v1/media/youtube/abc123');
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, title: 'A video', stored: { path: '/youtube/abc123', cached: true, status: 'available' } });
    expect(sourceCalls).toBe(0);
    await settle();
    expect((await row('abc123')).view_count).toBe(1);
  });

  it('fetches an item that was never stored when its link can be rebuilt from the id', async () => {
    const { status, json } = await get('/api/v1/media/youtube/newone1');
    expect(status).toBe(200);
    expect(json.stored).toMatchObject({ path: '/youtube/newone1', cached: false });
    expect(sourceCalls).toBe(1);
  });

  it('?cacheOnly=true never extracts', async () => {
    const { status, json } = await get('/api/v1/media/youtube/neverseen?cacheOnly=true');
    expect(status).toBe(404);
    expect(json.error.code).toBe('MEDIA_NOT_FOUND');
    expect(sourceCalls).toBe(0);
  });

  it('serves playlists under both path forms', async () => {
    await fetchMedia({ ...params, url: PLAYLIST_URL });
    for (const p of ['/api/v1/media/youtube/playlist/PL1', '/api/v1/media/youtube/abc123/playlist/PL1']) {
      const { status, json } = await get(p);
      expect(status).toBe(200);
      expect(json.playlist.items).toHaveLength(1);
    }
  });

  it('answers 410 with a tombstone for unavailable media', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await setRow('abc123', { status: 'unavailable', unavailable_reason: 'MEDIA_NOT_FOUND', unavailable_since: inPast(), last_check_at: new Date() });
    const { status, json } = await get('/api/v1/media/youtube/abc123');
    expect(status).toBe(410);
    expect(json.error).toMatchObject({ code: 'MEDIA_UNAVAILABLE', details: { tombstone: { title: 'A video', reason: 'MEDIA_NOT_FOUND' } } });
  });

  it('never serves login-only rows, and rejects unknown paths', async () => {
    await fetchMedia({ ...params, url: VIDEO_URL });
    await setRow('abc123', { is_public: false });
    expect((await get('/api/v1/media/youtube/abc123')).status).toBe(404);
    expect((await get('/api/v1/media/nowhere/xyz')).status).toBe(404);
    expect((await get('/api/v1/media/youtube')).status).toBe(404);
  });
});
