import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/utils/url', async () => ({ ...await vi.importActual('../../src/utils/url'), assertUrlIsSafeToFetch: vi.fn(async () => undefined) }));
vi.mock('../../src/core/ytdlp/ytdlpRunner', async () => ({ ...await vi.importActual('../../src/core/ytdlp/ytdlpRunner'), runYtdlp: vi.fn() }));
import { runYtdlp } from '../../src/core/ytdlp/ytdlpRunner';
import { YouTubeAdapter } from '../../src/core/adapters/YouTubeAdapter';
import { env } from '../../src/config/env';
const context = { requestId: 'playlist', normalizedUrl: { platform: 'youtube' as const, originalUrl: 'https://www.youtube.com/playlist?list=PLtest', canonicalUrl: 'https://www.youtube.com/playlist?list=PLtest', playlistId: 'PLtest' } };
beforeEach(() => vi.clearAllMocks());
describe('YouTube playlist completeness', () => {
  it('returns all 210 entries under the default listing limit instead of the old 200 cap', async () => {
    expect(env.MAX_PLAYLIST_ITEMS).toBe(1000);
    const entries = Array.from({ length: 210 }, (_, i) => ({ id: String(i).padStart(11, '0'), title: `Video ${i + 1}` }));
    vi.mocked(runYtdlp).mockResolvedValue({ exitCode: 0, stderr: '', stdout: JSON.stringify({ id: 'PLtest', title: 'Playlist', playlist_count: 210, entries }) });
    const result = await new YouTubeAdapter().fetchMetadata(context);
    expect(result.playlist?.items).toHaveLength(210);
    expect(result.metadata).toMatchObject({ playlistLimit: 1000, playlistTotal: 210, playlistTruncated: false });
    expect(runYtdlp).toHaveBeenCalledWith({ args: expect.arrayContaining(['--playlist-end', '1000']) });
  });
  it('reports truncation instead of claiming a limited list is complete', async () => {
    vi.mocked(runYtdlp).mockResolvedValue({ exitCode: 0, stderr: '', stdout: JSON.stringify({ id: 'PLtest', playlist_count: 210, entries: [{ id: 'dQw4w9WgXcQ', title: 'One' }] }) });
    expect((await new YouTubeAdapter().fetchMetadata(context)).metadata.playlistTruncated).toBe(true);
  });
});
