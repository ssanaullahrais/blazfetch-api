import { NormalizedUrlResult } from '../../utils/url';
import { logger } from '../../lib/logger';
import { fetchTiktokViaTobyG74 } from '../fallback/tiktok/tobyg74Adapter';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchResponse } from '../../types/blazfetch';

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
    try {
      return await this.delegate.download(ctx, target);
    } catch (err) {
      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp download failed for TikTok, trying fallback stream');
      const metadata = await fetchTiktokViaTobyG74(ctx.normalizedUrl.canonicalUrl);
      const format = metadata.formats.find((f) => f.formatId === target.formatId) ?? metadata.formats[0];
      if (!format?.url) throw err;
      return {
        filePath: '',
        filename: `${metadata.mediaId}.mp4`,
        mimeType: 'video/mp4',
        bytes: 0,
        directUrl: format.url,
      };
    }
  }
}
