import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';
import { assertUrlIsSafeToFetch, NormalizedUrlResult } from '../../utils/url';
import { classifyYtdlpFailure, runYtdlp } from '../ytdlp/ytdlpRunner';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchPlaylistItem, BlazfetchResponse } from '../../types/blazfetch';

interface FlatPlaylistEntry {
  id: string;
  title: string;
  thumbnails?: { url: string }[];
  duration?: number;
  url?: string;
}

interface FlatPlaylistInfo {
  id: string;
  title?: string;
  thumbnails?: { url: string }[];
  channel?: string;
  entries: FlatPlaylistEntry[];
}

/**
 * YouTube uses the generic yt-dlp path for single videos/shorts/live (already canonicalized
 * by utils/url.ts), but adds fast flat-playlist listing so a playlist URL doesn't pay the cost
 * of resolving full formats for every entry up front.
 */
export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = 'youtube' as const;
  private readonly delegate = new GenericYtDlpAdapter('youtube');

  supports(normalizedUrl: NormalizedUrlResult): boolean {
    return normalizedUrl.platform === 'youtube';
  }

  async fetchMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    const { normalizedUrl } = ctx;

    if (normalizedUrl.playlistId && !normalizedUrl.videoId) {
      return this.fetchPlaylist(ctx);
    }

    return this.delegate.fetchMetadata(ctx);
  }

  private async fetchPlaylist(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    const targetUrl = ctx.normalizedUrl.canonicalUrl;
    await assertUrlIsSafeToFetch(targetUrl);

    const { stdout, stderr, exitCode } = await runYtdlp({
      args: [
        '-J',
        '--flat-playlist',
        '--no-warnings',
        '--playlist-end', String(env.MAX_PLAYLIST_ITEMS),
        targetUrl,
      ],
    });

    if (exitCode !== 0) {
      throw classifyYtdlpFailure(stderr);
    }

    let info: FlatPlaylistInfo;
    try {
      info = JSON.parse(stdout);
    } catch {
      throw new BlazfetchError('EXTRACTOR_FAILED', 'Failed to parse playlist output.');
    }

    const items: BlazfetchPlaylistItem[] = (info.entries ?? []).map((entry) => ({
      videoId: entry.id,
      title: entry.title,
      thumbnail: entry.thumbnails?.at(-1)?.url,
      durationSeconds: entry.duration,
      url: entry.url ?? `https://www.youtube.com/watch?v=${entry.id}`,
    }));

    return {
      success: true,
      platform: 'youtube',
      mediaType: 'playlist',
      mediaId: info.id,
      canonicalUrl: targetUrl,
      title: info.title,
      thumbnail: info.thumbnails?.at(-1)?.url,
      isPlaylist: true,
      itemCount: items.length,
      playlist: {
        title: info.title,
        thumbnail: info.thumbnails?.at(-1)?.url,
        channel: info.channel,
        itemCount: items.length,
        items,
      },
      formats: [],
      audioFormats: [],
      metadata: {},
      extractor: 'yt-dlp',
    };
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    return this.delegate.download(ctx, target);
  }
}
