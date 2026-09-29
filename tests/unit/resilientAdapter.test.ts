import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlazfetchError } from '../../src/constants/errors';
import { env } from '../../src/config/env';
import { ResilientAdapter } from '../../src/core/adapters/ResilientAdapter';
import { fetchCobaltMedia } from '../../src/core/fallback/cobalt';
import { fetchPlaylistViaApi } from '../../src/core/fallback/youtube/playlistApi';
import type { AdapterFetchContext } from '../../src/core/adapters/types';

vi.mock('../../src/utils/url', () => ({ assertUrlIsSafeToFetch: vi.fn(async (value: string) => {
  const url = new URL(value);
  if (url.hostname === '127.0.0.1') throw new BlazfetchError('INVALID_URL', 'Blocked private address');
  return url;
}) }));

const original = { cobalt: env.COBALT_API_URL, key: env.COBALT_API_KEY, youtube: env.YOUTUBE_DATA_API_KEY, limit: env.MAX_PLAYLIST_ITEMS };
const ctx: AdapterFetchContext = { requestId: 'test', normalizedUrl: { platform: 'youtube', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', originalUrl: 'https://youtu.be/dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ' } };
const request = vi.fn<typeof fetch>();
const primary = { platform: 'youtube' as const, supports: () => true, fetchMetadata: vi.fn(), download: vi.fn() };
const adapter = new ResilientAdapter(primary);
const media = { status: 'tunnel', url: 'https://fallback.example/tunnel/123', filename: 'video.mp4' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  env.COBALT_API_URL = 'https://fallback.example/';
  env.COBALT_API_KEY = 'secret';
  env.YOUTUBE_DATA_API_KEY = 'youtube-secret';
  vi.stubGlobal('fetch', request);
  request.mockImplementation(async (_url, options) => json({ ...media, filename: JSON.parse(options?.body as string).downloadMode === 'audio' ? 'audio.mp3' : 'video.mp4' }));
});
afterEach(() => {
  env.COBALT_API_URL = original.cobalt;
  env.COBALT_API_KEY = original.key;
  env.YOUTUBE_DATA_API_KEY = original.youtube;
  env.MAX_PLAYLIST_ITEMS = original.limit;
  vi.unstubAllGlobals();
});

describe('independent fallback', () => {
  it('does not contact the provider when the primary works', async () => {
    primary.fetchMetadata.mockResolvedValueOnce({ title: 'primary' });
    expect(await adapter.fetchMetadata(ctx)).toEqual({ title: 'primary' });
    expect(request).not.toHaveBeenCalled();
  });
  it('recovers a blocked extractor with video and real MP3 audio', async () => {
    primary.fetchMetadata.mockRejectedValueOnce(new BlazfetchError('PLATFORM_RATE_LIMITED', 'blocked'));
    const result = await adapter.fetchMetadata(ctx);
    expect(result).toMatchObject({ mediaId: 'dQw4w9WgXcQ', fallbackUsed: 'cobalt' });
    expect(result.formats[0]).toMatchObject({ formatId: 'cobalt-video', ext: 'mp4' });
    expect(result.audioFormats[0]).toMatchObject({ formatId: 'cobalt-audio', ext: 'mp3' });
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Api-Key secret' } });
  });
  it('recovers Newgrounds audio pages as audio rather than rejecting an MP3 as video', async () => {
    const audioCtx: AdapterFetchContext = { requestId: 'test', normalizedUrl: { platform: 'newgrounds', canonicalUrl: 'https://www.newgrounds.com/audio/listen/549479', originalUrl: 'https://www.newgrounds.com/audio/listen/549479' } };
    const audioPrimary = { platform: 'newgrounds' as const, supports: () => true, fetchMetadata: vi.fn().mockRejectedValue(new BlazfetchError('EXTRACTOR_FAILED', 'blocked')), download: vi.fn() };
    request.mockResolvedValue(json({ ...media, filename: 'track.mp3' }));
    const result = await new ResilientAdapter(audioPrimary).fetchMetadata(audioCtx);
    expect(result).toMatchObject({ mediaType: 'audio', fallbackUsed: 'cobalt', formats: [] });
    expect(result.audioFormats[0]).toMatchObject({ formatId: 'cobalt-audio', ext: 'mp3' });
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toMatchObject({ downloadMode: 'audio' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps Newgrounds movie recovery in video mode with a separate audio option', async () => {
    const movieCtx: AdapterFetchContext = { requestId: 'test', normalizedUrl: { platform: 'newgrounds', canonicalUrl: 'https://www.newgrounds.com/portal/view/841932', originalUrl: 'https://www.newgrounds.com/portal/view/841932' } };
    const moviePrimary = { platform: 'newgrounds' as const, supports: () => true, fetchMetadata: vi.fn().mockRejectedValue(new BlazfetchError('EXTRACTOR_FAILED', 'blocked')), download: vi.fn() };
    const result = await new ResilientAdapter(moviePrimary).fetchMetadata(movieCtx);
    expect(result).toMatchObject({ mediaType: 'video', fallbackUsed: 'cobalt' });
    expect(result.formats[0]).toMatchObject({ formatId: 'cobalt-video', ext: 'mp4' });
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toMatchObject({ downloadMode: 'auto' });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['PRIVATE_MEDIA', 'MEDIA_NOT_FOUND', 'GEO_RESTRICTED', 'AGE_RESTRICTED'] as const)('preserves %s without calling the fallback', async (code) => {
    primary.fetchMetadata.mockRejectedValueOnce(new BlazfetchError(code, 'unavailable'));
    await expect(adapter.fetchMetadata(ctx)).rejects.toMatchObject({ code });
    expect(request).not.toHaveBeenCalled();
  });
  it('preserves the original error when the independent provider is unavailable', async () => {
    const error = new BlazfetchError('PLATFORM_RATE_LIMITED', 'blocked');
    primary.fetchMetadata.mockRejectedValueOnce(error);
    request.mockResolvedValueOnce(json({ status: 'error' }, 503));
    await expect(adapter.fetchMetadata(ctx)).rejects.toBe(error);
  });
  it('never fetches an independent provider unless configured', async () => {
    env.COBALT_API_URL = '';
    primary.fetchMetadata.mockRejectedValueOnce(new BlazfetchError('EXTRACTOR_FAILED', 'broken'));
    await expect(adapter.fetchMetadata(ctx)).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
    expect(request).not.toHaveBeenCalled();
  });
  it('refreshes provider-only formats without handing them to yt-dlp', async () => {
    const result = await adapter.download(ctx, { formatId: 'cobalt-video', kind: 'video', outputDir: '', signal: new AbortController().signal });
    expect(result).toMatchObject({ directUrl: media.url, mimeType: 'video/mp4' });
    expect(primary.download).not.toHaveBeenCalled();
  });
  it('does not retry a cancelled download', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(adapter.download(ctx, { formatId: 'cobalt-video', kind: 'video', outputDir: '', signal: controller.signal })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects a provider URL pointing at the internal network', async () => {
    request.mockResolvedValueOnce(json({ ...media, url: 'http://127.0.0.1/private' }));
    await expect(fetchCobaltMedia(ctx.normalizedUrl.canonicalUrl, 'video')).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
});

describe('official playlist fallback', () => {
  it('paginates while respecting the item limit', async () => {
    env.MAX_PLAYLIST_ITEMS = 2;
    request.mockResolvedValueOnce(json({ items: [{ snippet: { title: 'Playlist' } }] }))
      .mockResolvedValueOnce(json({ items: [{ contentDetails: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'One' } }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(json({ items: [{ contentDetails: { videoId: 'Cwkej79U3ek' }, snippet: { title: 'Two' } }], nextPageToken: 'ignored' }));
    const result = await fetchPlaylistViaApi('PLtest', 'https://www.youtube.com/playlist?list=PLtest');
    expect(result.playlist?.items.map((item) => item.videoId)).toEqual(['dQw4w9WgXcQ', 'Cwkej79U3ek']);
    expect(result).toMatchObject({ mediaType: 'playlist', fallbackUsed: 'youtube-data-api' });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('stops when the provider repeats a page token', async () => {
    request.mockResolvedValueOnce(json({ items: [{ snippet: { title: 'Playlist' } }] }))
      .mockResolvedValue(json({ items: [], nextPageToken: 'repeat' }));
    await expect(fetchPlaylistViaApi('PLtest', 'https://www.youtube.com/playlist?list=PLtest')).rejects.toMatchObject({ code: 'EXTRACTOR_FAILED' });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('does not leak API keys when a transport error includes the URL', async () => {
    request.mockRejectedValueOnce(new Error('https://api.example/?key=youtube-secret'));
    await expect(fetchPlaylistViaApi('PLtest', 'https://www.youtube.com/playlist?list=PLtest')).rejects.toThrow('YouTube playlist API request failed.');
  });
});
