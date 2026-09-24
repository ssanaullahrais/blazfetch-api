import fs from 'node:fs';
import path from 'node:path';
import mime from '../../lib/mime';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';
import { assertUrlIsSafeToFetch, NormalizedUrlResult } from '../../utils/url';
import { downloadWithYtdlp } from '../ytdlp/ytdlpDownload';
import { fetchPinterestBoard, fetchPinterestViaResourceApi, resolvePinItRedirect } from '../fallback/pinterest/pinterestApiFallback';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchItem, BlazfetchResponse } from '../../types/blazfetch';

type ResolvedPinterestTarget = { kind: 'pin'; pinId: string; url: string } | { kind: 'board'; username: string; slug: string; url: string };

/**
 * Pinterest's yt-dlp extractor can hit blocked/rate-limited responses even for valid pin URLs.
 * When that happens, this falls back to calling Pinterest's own PinResource/BoardResource APIs
 * directly — the exact same public, unauthenticated endpoints yt-dlp's extractor uses — which is
 * more resilient to whatever is tripping up the yt-dlp request path specifically (datacenter IP,
 * rate limiting, an outdated cached response, etc). See pinterestApiFallback.ts for the verified
 * request shape. A board URL is always handled through this API path (yt-dlp's board/collection
 * support has known gaps), returning every pin in the board as a carousel of items.
 */
export class PinterestAdapter implements PlatformAdapter {
  readonly platform = 'pinterest' as const;
  private readonly delegate = new GenericYtDlpAdapter('pinterest');

  supports(normalizedUrl: NormalizedUrlResult): boolean {
    return normalizedUrl.platform === 'pinterest';
  }

  private async resolveTarget(canonicalUrl: string): Promise<ResolvedPinterestTarget> {
    let url = new URL(canonicalUrl);
    if (url.hostname === 'pin.it') {
      const resolved = await resolvePinItRedirect(canonicalUrl);
      url = new URL(resolved);
    }

    const path = url.pathname.replace(/\/+$/, '');
    const pinMatch = path.match(/^\/pin\/(\d+)/);
    if (pinMatch) {
      return { kind: 'pin', pinId: pinMatch[1], url: `https://www.pinterest.com${path}` };
    }

    const segments = path.split('/').filter(Boolean);
    if (segments.length === 2) {
      return { kind: 'board', username: segments[0], slug: segments[1], url: `https://www.pinterest.com${path}` };
    }

    throw new BlazfetchError('INVALID_URL', 'This does not resolve to an individual Pinterest pin or a single user board.');
  }

  async fetchMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    const target = await this.resolveTarget(ctx.normalizedUrl.canonicalUrl);

    if (target.kind === 'board') {
      return this.fetchBoard(target, ctx.requestId, ctx.range);
    }

    const resolvedCtx: AdapterFetchContext = { ...ctx, normalizedUrl: { ...ctx.normalizedUrl, canonicalUrl: target.url } };
    try {
      return await this.delegate.fetchMetadata(resolvedCtx);
    } catch (err) {
      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp failed for Pinterest, falling back to PinResource API');
      return this.fetchPinViaApi(target.pinId, target.url);
    }
  }

  private async fetchPinViaApi(pinId: string, canonicalUrl: string): Promise<BlazfetchResponse> {
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
      canonicalUrl,
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

  private async fetchBoard(
    target: { username: string; slug: string; url: string },
    requestId: string,
    range?: { start?: number; end?: number },
  ): Promise<BlazfetchResponse> {
    logger.info({ requestId, username: target.username, slug: target.slug, range }, 'fetching Pinterest board via BoardResource/BoardFeedResource API');
    const board = await fetchPinterestBoard(target.username, target.slug, env.MAX_PLAYLIST_ITEMS, range);

    const items: BlazfetchItem[] = board.items.map((item) => ({
      id: item.pinId,
      type: item.type,
      thumbnail: item.thumbnail,
      source: item.type === 'image' ? item.thumbnail : undefined,
      durationSeconds: item.durationSeconds,
      formats:
        item.type === 'video'
          ? [
              ...(item.mp4Url ? [{ formatId: `board-${item.pinId}-mp4`, ext: 'mp4', kind: 'video' as const, url: item.mp4Url, width: item.mp4Width, height: item.mp4Height, compatible: true }] : []),
              ...(item.hlsUrl ? [{ formatId: `board-${item.pinId}-hls`, ext: 'm3u8', kind: 'video' as const, url: item.hlsUrl, compatible: true }] : []),
            ]
          : undefined,
    }));

    return {
      success: true,
      platform: 'pinterest',
      mediaType: 'carousel',
      mediaId: board.boardId,
      canonicalUrl: target.url,
      title: board.boardName,
      thumbnail: board.thumbnail,
      isCarousel: true,
      itemCount: items.length,
      items,
      formats: [],
      audioFormats: [],
      metadata: {
        truncated: board.truncated,
        maxItemsPerRequest: env.MAX_PLAYLIST_ITEMS,
        totalPinCount: board.totalPinCount,
        rangeStart: board.rangeStart,
        rangeEnd: board.rangeEnd,
      },
      extractor: 'pinterest-board-api',
      fallbackUsed: 'pinterest-board-api',
    };
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    const resolved = await this.resolveTarget(ctx.normalizedUrl.canonicalUrl);

    if (resolved.kind === 'board') {
      // A board download always resolves a specific item's format (formatId `board-<pinId>-*`,
      // as returned by fetchMetadata); the board itself is not a single downloadable file.
      return this.downloadBoardItem(resolved, target);
    }

    const resolvedCtx: AdapterFetchContext = { ...ctx, normalizedUrl: { ...ctx.normalizedUrl, canonicalUrl: resolved.url } };
    try {
      return await this.delegate.download(resolvedCtx, target);
    } catch (err) {
      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp download failed for Pinterest, using PinResource API fallback');
      const fallback = await fetchPinterestViaResourceApi(resolved.pinId);
      const sourceUrl = target.formatId === 'api-hls' ? fallback.hlsUrl : fallback.mp4Url ?? fallback.hlsUrl;
      if (!sourceUrl) throw err;
      return this.deliverResolvedUrl(sourceUrl, target);
    }
  }

  private async downloadBoardItem(resolved: { username: string; slug: string; url: string }, target: DownloadTarget): Promise<DownloadResult> {
    const match = target.formatId.match(/^board-(\d+)-(mp4|hls)$/);
    if (!match) {
      throw new BlazfetchError('FORMAT_UNAVAILABLE', 'Board downloads require a formatId returned by fetching this board (board-<pinId>-mp4/hls).');
    }
    const [, pinId, kind] = match;
    const fallback = await fetchPinterestViaResourceApi(pinId);
    const sourceUrl = kind === 'hls' ? fallback.hlsUrl : fallback.mp4Url;
    if (!sourceUrl) {
      throw new BlazfetchError('FORMAT_UNAVAILABLE', `Pin ${pinId} in this board no longer has that format available.`);
    }
    return this.deliverResolvedUrl(sourceUrl, target);
  }

  private async deliverResolvedUrl(sourceUrl: string, target: DownloadTarget): Promise<DownloadResult> {
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

    // The resolved MP4 CDN URL is unsigned and permanent (confirmed: no query string, plain 200
    // on a direct unauthenticated fetch) so it can be streamed straight through to the client
    // instead of downloading it server-side first.
    return { filePath: '', filename: `${target.formatId}.mp4`, mimeType: 'video/mp4', bytes: 0, directUrl: sourceUrl };
  }
}
