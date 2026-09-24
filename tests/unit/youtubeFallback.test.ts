import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ytdlpFetch: vi.fn(),
  ytdlpDownload: vi.fn(),
  fallbackFetch: vi.fn(),
}));

vi.mock('../../src/core/adapters/GenericYtDlpAdapter', () => ({
  GenericYtDlpAdapter: class {
    fetchMetadata = mocks.ytdlpFetch;
    download = mocks.ytdlpDownload;
  },
}));

vi.mock('../../src/core/fallback/youtube/btchYoutube', () => ({ fetchYoutubeViaBtch: mocks.fallbackFetch }));

vi.mock('../../src/utils/url', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/url')>('../../src/utils/url');
  return { ...actual, assertUrlIsSafeToFetch: vi.fn(async (raw: string) => new URL(raw)) };
});

import { env } from '../../src/config/env';
import { BlazfetchError } from '../../src/constants/errors';
import { classifyYtdlpFailure } from '../../src/core/ytdlp/ytdlpRunner';
import { YouTubeAdapter, resetYoutubeBlock } from '../../src/core/adapters/YouTubeAdapter';

const ctx = {
  requestId: 'r1',
  normalizedUrl: { platform: 'youtube', canonicalUrl: 'https://www.youtube.com/watch?v=abc123', originalUrl: 'https://youtu.be/abc123', videoId: 'abc123' },
} as never;

const ytdlpResult = { success: true, platform: 'youtube', mediaId: 'abc123', title: 'From yt-dlp', formats: [], audioFormats: [], metadata: {}, extractor: 'yt-dlp' };
const botCheck = (): BlazfetchError => classifyYtdlpFailure("ERROR: [youtube] abc123: Sign in to confirm you're not a bot.");
const fallbackResult = { title: 'From fallback', thumbnail: 'https://img/t.jpg', author: 'An Author', mp4: 'https://cdn/video.mp4', mp3: 'https://cdn/audio.mp3' };

let adapter: YouTubeAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  resetYoutubeBlock();
  (env as { YOUTUBE_FALLBACK_ENABLED: boolean }).YOUTUBE_FALLBACK_ENABLED = true;
  mocks.ytdlpFetch.mockResolvedValue(ytdlpResult);
  mocks.fallbackFetch.mockResolvedValue(fallbackResult);
  adapter = new YouTubeAdapter();
});

describe('classifier', () => {
  it('flags the bot check so callers can back off, but not an age gate', () => {
    expect(botCheck()).toMatchObject({ code: 'LOGIN_REQUIRED', details: { botCheck: true } });
    const ageGate = classifyYtdlpFailure('ERROR: Sign in to confirm your age');
    expect(ageGate.code).toBe('LOGIN_REQUIRED');
    expect(ageGate.details).toBeUndefined();
  });
});

describe('YouTube fetch fallback', () => {
  it('uses yt-dlp when it works and never touches the fallback', async () => {
    const result = await adapter.fetchMetadata(ctx);
    expect(result.title).toBe('From yt-dlp');
    expect(mocks.fallbackFetch).not.toHaveBeenCalled();
  });

  it('falls back to the provider when YouTube shows the bot check', async () => {
    mocks.ytdlpFetch.mockRejectedValue(botCheck());
    const result = await adapter.fetchMetadata(ctx);
    expect(result).toMatchObject({
      platform: 'youtube',
      mediaId: 'abc123',
      title: 'From fallback',
      thumbnail: 'https://img/t.jpg',
      author: { name: 'An Author' },
      extractor: 'btch-downloader',
      fallbackUsed: 'btch-downloader',
    });
    expect(result.formats[0]).toMatchObject({ formatId: 'btch-mp4', ext: 'mp4', url: 'https://cdn/video.mp4' });
    expect(result.audioFormats[0]).toMatchObject({ formatId: 'btch-m4a', ext: 'm4a', url: 'https://cdn/audio.mp3' });
  });

  it('after a bot check, skips yt-dlp for the cooldown so YouTube is not hammered', async () => {
    mocks.ytdlpFetch.mockRejectedValue(botCheck());
    await adapter.fetchMetadata(ctx);
    await adapter.fetchMetadata(ctx);
    await adapter.fetchMetadata(ctx);
    expect(mocks.ytdlpFetch).toHaveBeenCalledTimes(1); // only the request that discovered the block
    expect(mocks.fallbackFetch).toHaveBeenCalledTimes(3);
  });

  it('tries yt-dlp again once the cooldown is over', async () => {
    mocks.ytdlpFetch.mockRejectedValueOnce(botCheck());
    await adapter.fetchMetadata(ctx);
    resetYoutubeBlock(); // the cooldown has passed
    const result = await adapter.fetchMetadata(ctx);
    expect(result.title).toBe('From yt-dlp');
    expect(mocks.ytdlpFetch).toHaveBeenCalledTimes(2);
  });

  it('still tries yt-dlp during the cooldown if the fallback is failing too', async () => {
    mocks.ytdlpFetch.mockRejectedValueOnce(botCheck());
    await adapter.fetchMetadata(ctx);
    mocks.fallbackFetch.mockRejectedValue(new BlazfetchError('EXTRACTOR_FAILED', 'fallback down'));
    const result = await adapter.fetchMetadata(ctx);
    expect(result.title).toBe('From yt-dlp');
  });

  it('a plain sign-in requirement (age gate) uses the fallback but does not start a cooldown', async () => {
    mocks.ytdlpFetch.mockRejectedValue(classifyYtdlpFailure('ERROR: Sign in to confirm your age'));
    await adapter.fetchMetadata(ctx);
    await adapter.fetchMetadata(ctx);
    expect(mocks.ytdlpFetch).toHaveBeenCalledTimes(2);
  });

  it.each(['MEDIA_NOT_FOUND', 'PRIVATE_MEDIA', 'GEO_RESTRICTED', 'AGE_RESTRICTED'] as const)('does not use the fallback for %s', async (code) => {
    mocks.ytdlpFetch.mockRejectedValue(new BlazfetchError(code, 'no'));
    await expect(adapter.fetchMetadata(ctx)).rejects.toMatchObject({ code });
    expect(mocks.fallbackFetch).not.toHaveBeenCalled();
  });

  it('reports the original yt-dlp error when the fallback fails as well', async () => {
    mocks.ytdlpFetch.mockRejectedValue(botCheck());
    mocks.fallbackFetch.mockRejectedValue(new BlazfetchError('EXTRACTOR_FAILED', 'fallback down'));
    await expect(adapter.fetchMetadata(ctx)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });

  it('can be turned off with YOUTUBE_FALLBACK_ENABLED=false', async () => {
    (env as { YOUTUBE_FALLBACK_ENABLED: boolean }).YOUTUBE_FALLBACK_ENABLED = false;
    mocks.ytdlpFetch.mockRejectedValue(botCheck());
    await expect(adapter.fetchMetadata(ctx)).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(mocks.fallbackFetch).not.toHaveBeenCalled();
  });
});

describe('YouTube download fallback', () => {
  const target = (formatId: string, kind: 'video' | 'audio' = 'video') => ({ formatId, kind, outputDir: 'x', signal: new AbortController().signal });

  it('serves a fallback-provider format as a direct link without involving yt-dlp', async () => {
    const result = await adapter.download(ctx, target('btch-mp4'));
    expect(result).toMatchObject({ directUrl: 'https://cdn/video.mp4', mimeType: 'video/mp4', filename: 'abc123.mp4', filePath: '' });
    expect(mocks.ytdlpDownload).not.toHaveBeenCalled();
  });

  it('serves the audio link as m4a (the provider mp3 link is really AAC in MP4)', async () => {
    const result = await adapter.download(ctx, target('btch-m4a', 'audio'));
    expect(result).toMatchObject({ directUrl: 'https://cdn/audio.mp3', mimeType: 'audio/mp4', filename: 'abc123.m4a' });
  });

  it('falls back to a direct link when yt-dlp download hits the bot check, and starts the cooldown', async () => {
    mocks.ytdlpDownload.mockRejectedValue(botCheck());
    const result = await adapter.download(ctx, target('18'));
    expect(result.directUrl).toBe('https://cdn/video.mp4');

    mocks.ytdlpDownload.mockClear();
    await adapter.download(ctx, target('18'));
    expect(mocks.ytdlpDownload).not.toHaveBeenCalled(); // cooldown: straight to the fallback
  });

  it('keeps using yt-dlp when it works', async () => {
    mocks.ytdlpDownload.mockResolvedValue({ filePath: '/tmp/x.mp4', filename: 'x.mp4', mimeType: 'video/mp4', bytes: 1 });
    const result = await adapter.download(ctx, target('18'));
    expect(result.filePath).toBe('/tmp/x.mp4');
    expect(mocks.fallbackFetch).not.toHaveBeenCalled();
  });

  it('rethrows the yt-dlp error when the fallback cannot help', async () => {
    mocks.ytdlpDownload.mockRejectedValue(botCheck());
    mocks.fallbackFetch.mockRejectedValue(new BlazfetchError('EXTRACTOR_FAILED', 'fallback down'));
    await expect(adapter.download(ctx, target('18'))).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });
});
