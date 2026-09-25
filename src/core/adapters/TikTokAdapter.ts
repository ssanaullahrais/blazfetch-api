import { NormalizedUrlResult } from '../../utils/url';
import { logger } from '../../lib/logger';
import { fetchTiktokViaTobyG74 } from '../fallback/tiktok/tobyg74Adapter';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchResponse } from '../../types/blazfetch';
import { BlazfetchError } from '../../constants/errors';

/** Format ids that come from the fallback provider (see tobyg74Adapter), not from yt-dlp. */
const FALLBACK_FORMAT_IDS = new Set(['hd', 'sd', 'watermark', 'original']);

export class TikTokAdapter implements PlatformAdapter {
  readonly platform = 'tiktok' as const;
  private readonly delegate = new GenericYtDlpAdapter('tiktok');

  supports(normalizedUrl: NormalizedUrlResult): boolean {
    return normalizedUrl.platform === 'tiktok';
  }

  async fetchMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    try {
      return await this.delegate.fetchMetadata(ctx);
    } catch (err) {
      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp failed for TikTok, trying fallback');
      return fetchTiktokViaTobyG74(ctx.normalizedUrl.canonicalUrl);
    }
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    // A format the fallback provider listed only exists there: yt-dlp would just fail on it first.
    if (FALLBACK_FORMAT_IDS.has(target.formatId)) return this.fallbackDownload(ctx, target);
    try {
      return await this.delegate.download(ctx, target);
    } catch (err) {
      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp download failed for TikTok, trying fallback stream');
      return this.fallbackDownload(ctx, target, err);
    }
  }

  /** The provider hands out direct links, which the backend proxies to the client. */
  private async fallbackDownload(ctx: AdapterFetchContext, target: DownloadTarget, originalError?: unknown): Promise<DownloadResult> {
    const metadata = await fetchTiktokViaTobyG74(ctx.normalizedUrl.canonicalUrl);
    const audio = target.kind === 'audio';
    const format = audio
      ? (metadata.audioFormats.find((f) => f.formatId === target.formatId) ?? metadata.audioFormats[0])
      : (metadata.formats.find((f) => f.formatId === target.formatId) ?? metadata.formats[0]);
    if (!format?.url) {
      throw originalError ?? new BlazfetchError('FORMAT_UNAVAILABLE', 'The TikTok fallback provider has no link for this format.');
    }
    return {
      filePath: '',
      filename: `${metadata.mediaId}.${format.ext}`,
      mimeType: audio ? 'audio/mpeg' : 'video/mp4',
      bytes: 0,
      directUrl: format.url,
    };
  }
}
