import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GenericYtDlpAdapter } from '../../src/core/adapters/GenericYtDlpAdapter';
import { BlazfetchError } from '../../src/constants/errors';
import { runYtdlp } from '../../src/core/ytdlp/ytdlpRunner';
import { downloadWithYtdlp } from '../../src/core/ytdlp/ytdlpDownload';
import type { AdapterFetchContext } from '../../src/core/adapters/types';

vi.mock('../../src/utils/url', () => ({ assertUrlIsSafeToFetch: vi.fn(async () => undefined) }));
vi.mock('../../src/core/ytdlp/ytdlpRunner', () => ({ runYtdlp: vi.fn(), classifyYtdlpFailure: () => new BlazfetchError('EXTRACTOR_FAILED', 'failed') }));
vi.mock('../../src/core/ytdlp/ytdlpDownload', () => ({ downloadWithYtdlp: vi.fn() }));
vi.mock('node:fs', () => ({ default: { promises: { stat: vi.fn(async () => ({ size: 123 })) } } }));
const ctx: AdapterFetchContext = { requestId: 'test', normalizedUrl: { platform: 'tumblr', originalUrl: 'https://example.tumblr.com/post/123/video', canonicalUrl: 'https://example.tumblr.com/post/123/video' } };
const raw = { id: 'video', title: 'Public video', formats: [{ format_id: '0', ext: 'mp4', vcodec: 'h264', acodec: 'aac', url: 'https://va.media.tumblr.com/video.mp4' }] };
const success = { stdout: JSON.stringify(raw), stderr: '', exitCode: 0 };
beforeEach(() => vi.clearAllMocks());
describe('Tumblr public-page recovery', () => {
  it('uses the public generic extractor after a dedicated timeout and keeps stable post identity', async () => {
    vi.mocked(runYtdlp).mockRejectedValueOnce(new BlazfetchError('PROCESS_TIMEOUT', 'timeout')).mockResolvedValueOnce(success);
    const result = await new GenericYtDlpAdapter('tumblr').fetchMetadata(ctx);
    expect(result).toMatchObject({ mediaId: '123', fallbackUsed: 'yt-dlp-generic' });
    expect(result.formats[0].formatId).toBe('tumblr-generic-0');
    expect(vi.mocked(runYtdlp).mock.calls[1][0].args).toContain('--force-generic-extractor');
  });
  it.each(['PRIVATE_MEDIA', 'MEDIA_NOT_FOUND', 'AGE_RESTRICTED', 'GEO_RESTRICTED', 'LOGIN_REQUIRED'] as const)('does not retry %s', async (code) => {
    vi.mocked(runYtdlp).mockRejectedValueOnce(new BlazfetchError(code, 'restricted'));
    await expect(new GenericYtDlpAdapter('tumblr').fetchMetadata(ctx)).rejects.toMatchObject({ code });
    expect(runYtdlp).toHaveBeenCalledTimes(1);
  });
  it('preserves the original failure if recovery fails', async () => {
    vi.mocked(runYtdlp).mockRejectedValueOnce(new BlazfetchError('PROCESS_TIMEOUT', 'original')).mockRejectedValueOnce(new Error('fallback'));
    await expect(new GenericYtDlpAdapter('tumblr').fetchMetadata(ctx)).rejects.toMatchObject({ message: 'original' });
  });
  it('keeps dedicated formats unchanged when the primary works', async () => {
    vi.mocked(runYtdlp).mockResolvedValueOnce(success);
    const result = await new GenericYtDlpAdapter('tumblr').fetchMetadata(ctx);
    expect(result.formats[0].formatId).toBe('0');
    expect(runYtdlp).toHaveBeenCalledTimes(1);
  });
  it('uses the same extractor for a prepared fallback format', async () => {
    vi.mocked(downloadWithYtdlp).mockResolvedValueOnce('video.mp4');
    await new GenericYtDlpAdapter('tumblr').download(ctx, { formatId: 'tumblr-generic-0', kind: 'video', outputDir: 'unused', signal: new AbortController().signal });
    expect(downloadWithYtdlp).toHaveBeenCalledWith(expect.objectContaining({ formatId: '0', forceGenericExtractor: true }));
  });
});
