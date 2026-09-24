import fs from 'node:fs';
import path from 'node:path';
import mime from '../../lib/mime';
import { logger } from '../../lib/logger';
import { BlazfetchError } from '../../constants/errors';
import { assertUrlIsSafeToFetch, NormalizedUrlResult } from '../../utils/url';
import { downloadWithYtdlp } from '../ytdlp/ytdlpDownload';
import { fetchPinterestViaResourceApi, resolvePinItRedirect } from '../fallback/pinterest/pinterestApiFallback';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchResponse } from '../../types/blazfetch';

/**
 * Pinterest's yt-dlp extractor can hit blocked/rate-limited responses even for valid pin URLs.
 * When that happens, this falls back to calling Pinterest's own PinResource API directly — the
 * exact same public, unauthenticated endpoint yt-dlp's extractor uses — which is more resilient
 * to whatever is tripping up the yt-dlp request path specifically (datacenter IP, rate limiting,
 * an outdated cached response, etc). See pinterestApiFallback.ts for the verified request shape.
 */
export class PinterestAdapter implements PlatformAdapter {
  readonly platform = 'pinterest' as const;
  private readonly delegate = new GenericYtDlpAdapter('pinterest');

  supports(normalizedUrl: NormalizedUrlResult): boolean {
    return normalizedUrl.platform === 'pinterest';
  }

  private async resolveCanonicalUrl(canonicalUrl: string): Promise<string> {
    const url = new URL(canonicalUrl);
    if (url.hostname !== 'pin.it') return canonicalUrl;

    const resolved = await resolvePinItRedirect(canonicalUrl);
    const resolvedPath = new URL(resolved).pathname.replace(/\/+$/, '');
    if (!/^\/pin\/\d+/.test(resolvedPath)) {
      throw new BlazfetchError(
        'INVALID_URL',
        'This pin.it link does not resolve to an individual Pinterest pin (boards/search/collections are not supported).',
      );
    }
    return resolved;
  }

  private extractPinId(url: string): string {
    const match = new URL(url).pathname.match(/\/pin\/(\d+)/);
    if (!match) throw new BlazfetchError('INVALID_URL', 'Could not determine the Pinterest pin ID from this URL.');
    return match[1];
  }

  async fetchMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    const targetUrl = await this.resolveCanonicalUrl(ctx.normalizedUrl.canonicalUrl);
    const resolvedCtx: AdapterFetchContext = { ...ctx, normalizedUrl: { ...ctx.normalizedUrl, canonicalUrl: targetUrl } };

    try {
      return await this.delegate.fetchMetadata(resolvedCtx);
    } catch (err) {
      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp failed for Pinterest, falling back to PinResource API');
      const pinId = this.extractPinId(targetUrl);
      const fallback = await fetchPinterestViaResourceApi(pinId);

      const formats: BlazfetchResponse['formats'] = [];
      if (fallback.mp4Url) {
        formats.push({
          formatId: 'api-mp4',
          ext: 'mp4',
          kind: 'video',
          url: fallback.mp4Url,
          width: fallback.mp4Width,
          height: fallback.mp4Height,
          compatible: true,
        });
      }
      if (fallback.hlsUrl) {
        formats.push({ formatId: 'api-hls', ext: 'm3u8', kind: 'video', url: fallback.hlsUrl, compatible: true });
      }

      return {
        success: true,
        platform: 'pinterest',
        mediaType: 'video',
        mediaId: fallback.mediaId,
        canonicalUrl: targetUrl,
        title: fallback.title,
        thumbnail: fallback.thumbnail,
        durationSeconds: fallback.durationSeconds ?? null,
        formats,
        audioFormats: [],
        metadata: {},
        extractor: 'pinterest-resource-api',
        fallbackUsed: 'pinterest-resource-api',
      };
    }
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    const targetUrl = await this.resolveCanonicalUrl(ctx.normalizedUrl.canonicalUrl);
    const resolvedCtx: AdapterFetchContext = { ...ctx, normalizedUrl: { ...ctx.normalizedUrl, canonicalUrl: targetUrl } };

    try {
      return await this.delegate.download(resolvedCtx, target);
    } catch (err) {
      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp download failed for Pinterest, using PinResource API fallback');
      const pinId = this.extractPinId(targetUrl);
      const fallback = await fetchPinterestViaResourceApi(pinId);
      const sourceUrl = target.formatId === 'api-hls' ? fallback.hlsUrl : fallback.mp4Url ?? fallback.hlsUrl;
      if (!sourceUrl) throw err;

      if (sourceUrl.endsWith('.m3u8')) {
        // HLS needs assembling (fragments -> single file); hand the resolved URL straight to
        // yt-dlp/ffmpeg rather than trying to proxy an m3u8 playlist byte-for-byte.
        await assertUrlIsSafeToFetch(sourceUrl);
        const filePath = await downloadWithYtdlp({
          url: sourceUrl,
          formatId: 'best',
          outputDir: target.outputDir,
          signal: target.signal,
          onProgress: target.onProgress,
        });
        const stat = await fs.promises.stat(filePath);
        return { filePath, filename: path.basename(filePath), mimeType: mime.lookup(filePath) || 'video/mp4', bytes: stat.size };
      }

      // The resolved MP4 CDN URL is unsigned and permanent (confirmed: no query string, plain
      // 200 on a direct unauthenticated fetch) so it can be streamed straight through to the
      // client instead of downloading it server-side first.
      return { filePath: '', filename: `${target.formatId}.mp4`, mimeType: 'video/mp4', bytes: 0, directUrl: sourceUrl };
    }
  }
}
