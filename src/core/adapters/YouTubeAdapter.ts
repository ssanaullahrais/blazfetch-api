import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';
import { logger } from '../../lib/logger';
import { fetchYoutubeViaBtch } from '../fallback/youtube/btchYoutube';
import { assertUrlIsSafeToFetch, NormalizedUrlResult } from '../../utils/url';
import { classifyYtdlpFailure, runYtdlp } from '../ytdlp/ytdlpRunner';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchPlaylistItem, BlazfetchResponse } from '../../types/blazfetch';

/** Failures the fallback provider might get around. Not "gone", private, age or region errors. */
const FALLBACK_WORTHY = new Set(['LOGIN_REQUIRED', 'EXTRACTOR_FAILED', 'PLATFORM_RATE_LIMITED', 'PROCESS_TIMEOUT']);

function isFallbackWorthy(err: unknown): boolean {
  return err instanceof BlazfetchError && FALLBACK_WORTHY.has(err.code);
}

function isBotCheck(err: unknown): boolean {
  return err instanceof BlazfetchError && (err.details as { botCheck?: boolean } | undefined)?.botCheck === true;
}

/** Until when yt-dlp is skipped for YouTube because it just hit the bot check (shared by every request). */
let botBlockedUntil = 0;

/** Test hook. */
export function resetYoutubeBlock(): void {
  botBlockedUntil = 0;
}

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

    return this.fetchVideo(ctx);
  }

  /**
   * yt-dlp first. If YouTube blocks it (bot check) or it fails in a way a different provider might not,
   * the fallback provider answers instead. After a bot check yt-dlp is skipped for a cooldown so we do
   * not keep hitting YouTube while it is blocking us.
   */
  private async fetchVideo(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    const canFallback = env.YOUTUBE_FALLBACK_ENABLED && !!ctx.normalizedUrl.videoId;

    if (canFallback && Date.now() < botBlockedUntil) {
      try {
        return await this.fetchViaFallback(ctx);
      } catch (fallbackErr) {
        logger.warn({ requestId: ctx.requestId, err: (fallbackErr as Error).message }, 'YouTube fallback failed during cooldown, trying yt-dlp anyway');
      }
    }

    try {
      return await this.delegate.fetchMetadata(ctx);
    } catch (err) {
      if (!canFallback || !isFallbackWorthy(err)) throw err;
      if (isBotCheck(err)) {
        botBlockedUntil = Date.now() + env.YOUTUBE_BLOCK_COOLDOWN_SECONDS * 1000;
        logger.warn({ requestId: ctx.requestId, cooldownSeconds: env.YOUTUBE_BLOCK_COOLDOWN_SECONDS }, 'YouTube bot check hit; using the fallback provider for a while');
      }
      try {
        return await this.fetchViaFallback(ctx);
      } catch (fallbackErr) {
        logger.warn({ requestId: ctx.requestId, err: (fallbackErr as Error).message }, 'YouTube fallback also failed');
        throw err;
      }
    }
  }

  private async fetchViaFallback(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    const videoId = ctx.normalizedUrl.videoId as string;
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    await assertUrlIsSafeToFetch(canonicalUrl);
    const result = await fetchYoutubeViaBtch(canonicalUrl);

    return {
      success: true,
      platform: 'youtube',
      mediaType: 'video',
      mediaId: videoId,
      canonicalUrl,
      title: result.title,
      thumbnail: result.thumbnail,
      author: result.author ? { name: result.author } : undefined,
      formats: result.mp4
        ? [{ formatId: 'btch-mp4', ext: 'mp4', kind: 'video', quality: 'best available', url: result.mp4, compatible: true }]
        : [],
      audioFormats: result.mp3
        ? [{ formatId: 'btch-m4a', ext: 'm4a', isConverted: false, quality: 'aac', url: result.mp3 }]
        : [],
      metadata: {},
      extractor: 'btch-downloader',
      fallbackUsed: 'btch-downloader',
    };
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
    const fallbackEnabled = env.YOUTUBE_FALLBACK_ENABLED && !!ctx.normalizedUrl.videoId;

    // A format that came from the fallback provider can only be served by it (as a direct link).
    if (fallbackEnabled && target.formatId.startsWith('btch-')) {
      return this.fallbackDownload(ctx, target);
    }

    if (fallbackEnabled && Date.now() < botBlockedUntil) {
      try {
        return await this.fallbackDownload(ctx, target);
      } catch (fallbackErr) {
        logger.warn({ requestId: ctx.requestId, err: (fallbackErr as Error).message }, 'YouTube fallback download failed during cooldown, trying yt-dlp anyway');
      }
    }

    try {
      return await this.delegate.download(ctx, target);
    } catch (err) {
      if (!fallbackEnabled || !isFallbackWorthy(err)) throw err;
      if (isBotCheck(err)) botBlockedUntil = Date.now() + env.YOUTUBE_BLOCK_COOLDOWN_SECONDS * 1000;
      try {
        return await this.fallbackDownload(ctx, target);
      } catch {
        throw err;
      }
    }
  }

  /** The fallback provider hands out short-lived direct links, which the backend proxies to the client. */
  private async fallbackDownload(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    const metadata = await this.fetchViaFallback(ctx);
    const wantAudio = target.kind === 'audio';
    const format = wantAudio ? metadata.audioFormats[0] : metadata.formats[0];
    if (!format?.url) {
      throw new BlazfetchError('FORMAT_UNAVAILABLE', 'The fallback provider has no link for this format.');
    }
    return {
      filePath: '',
      filename: `${metadata.mediaId}.${format.ext}`,
      // The provider calls this link "mp3", but it is AAC in an MP4 container, so it is served as m4a.
      mimeType: wantAudio ? 'audio/mp4' : 'video/mp4',
      bytes: 0,
      directUrl: format.url,
    };
  }
}
