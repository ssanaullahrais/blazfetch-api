import { NormalizedUrlResult } from '../../utils/url';
import { logger } from '../../lib/logger';
import { fetchTwitterViaFxTwitter } from '../fallback/twitter/fxtwitterFallback';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchResponse } from '../../types/blazfetch';
import { BlazfetchError } from '../../constants/errors';

/** Format ids that come from the fallback provider (see fxtwitterFallback), not from yt-dlp. */
const FALLBACK_FORMAT_PREFIX = 'fx-';

/** Failures the fallback can get around: X hiding the media from anonymous requests, or a broken extractor. */
const FALLBACK_CODES = new Set(['MEDIA_NOT_FOUND', 'EXTRACTOR_FAILED', 'LOGIN_REQUIRED', 'AGE_RESTRICTED', 'MEDIA_UNAVAILABLE']);

/** X/Twitter through yt-dlp, with the FixTweet API as a fallback for posts yt-dlp cannot see. */
export class TwitterAdapter implements PlatformAdapter {
  readonly platform = 'twitter' as const;
  private readonly delegate = new GenericYtDlpAdapter('twitter');

  supports(normalizedUrl: NormalizedUrlResult): boolean {
    return normalizedUrl.platform === 'twitter';
  }

  async fetchMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    try {
      return await this.delegate.fetchMetadata(ctx);
    } catch (err) {
      if (!(err instanceof BlazfetchError) || !FALLBACK_CODES.has(err.code)) throw err;
      logger.warn({ requestId: ctx.requestId, err: err.message }, 'yt-dlp found no video for this X post, trying the fallback');
      try {
        return await fetchTwitterViaFxTwitter(ctx.normalizedUrl.canonicalUrl);
      } catch (fallbackErr) {
        // The post really has nothing to download (or the fallback is down): report yt-dlp's answer.
        logger.warn({ requestId: ctx.requestId, err: (fallbackErr as Error).message }, 'X fallback found nothing either');
        throw err;
      }
    }
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    // A format the fallback listed only exists there: yt-dlp would just fail on it first.
    if (target.formatId.startsWith(FALLBACK_FORMAT_PREFIX)) return this.fallbackDownload(ctx, target);
    try {
      return await this.delegate.download(ctx, target);
    } catch (err) {
      if (!(err instanceof BlazfetchError) || !FALLBACK_CODES.has(err.code)) throw err;
      logger.warn({ requestId: ctx.requestId, err: err.message }, 'yt-dlp download failed for this X post, trying the fallback');
      return this.fallbackDownload(ctx, target, err);
    }
  }

  /** The provider hands out direct links, which the backend proxies to the client. */
  private async fallbackDownload(ctx: AdapterFetchContext, target: DownloadTarget, originalError?: unknown): Promise<DownloadResult> {
    const metadata = await fetchTwitterViaFxTwitter(ctx.normalizedUrl.canonicalUrl);
    // Audio is made from the video: any listed quality will do, so the smallest one keeps it quick.
    const byId = metadata.formats.find((f) => f.formatId === target.formatId);
    const format = byId ?? (target.kind === 'audio' ? metadata.formats[metadata.formats.length - 1] : metadata.formats[0]);
    if (!format?.url) {
      throw originalError ?? new BlazfetchError('FORMAT_UNAVAILABLE', 'The X fallback provider has no link for this format.');
    }
    return {
      filePath: '',
      filename: `${metadata.mediaId}.mp4`,
      mimeType: 'video/mp4',
      bytes: 0,
      directUrl: format.url,
    };
  }
}
