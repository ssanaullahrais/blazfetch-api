import fs from 'node:fs';
import { NormalizedUrlResult } from '../../utils/url';
import { assertUrlIsSafeToFetch } from '../../utils/url';
import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';
import { logger } from '../../lib/logger';
import { classifyYtdlpFailure, runYtdlp } from '../ytdlp/ytdlpRunner';
import { normalizeFormats, normalizeYtdlpInfo, YtdlpRawInfo } from './ytdlpNormalize';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { fetchInstagramViaBtchDownloader } from '../fallback/instagram/btchDownloader';
import { fetchInstagramViaCakkatrok } from '../fallback/instagram/cakkatrokAdapter';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchItem, BlazfetchPlaylistItem, BlazfetchResponse } from '../../types/blazfetch';

interface YtdlpPlaylistInfo extends YtdlpRawInfo {
  _type?: string;
  entries?: YtdlpRawInfo[];
}

function guessExtFromUrl(url: string): string {
  const match = url.match(/\.(jpg|jpeg|png|webp|mp4|mov)(?:\?|$)/i);
  return match ? match[1].toLowerCase() : 'jpg';
}

/** Resolves the operator-supplied cookies file, only if configured and actually present on disk. */
function cookiesArgs(): string[] {
  if (!env.INSTAGRAM_COOKIES_PATH) return [];
  if (!fs.existsSync(env.INSTAGRAM_COOKIES_PATH)) {
    logger.warn({ path: env.INSTAGRAM_COOKIES_PATH }, 'INSTAGRAM_COOKIES_PATH is set but the file does not exist');
    return [];
  }
  return ['--cookies', env.INSTAGRAM_COOKIES_PATH];
}

export class InstagramAdapter implements PlatformAdapter {
  readonly platform = 'instagram' as const;
  private readonly delegate = new GenericYtDlpAdapter('instagram');

  supports(normalizedUrl: NormalizedUrlResult): boolean {
    return normalizedUrl.platform === 'instagram';
  }

  async fetchMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    const targetUrl = ctx.normalizedUrl.canonicalUrl;

    // Layer 1 & 2: yt-dlp, allowing playlist expansion so carousel posts return every entry.
    try {
      await assertUrlIsSafeToFetch(targetUrl);
      const { stdout, stderr, exitCode } = await runYtdlp({ args: [...cookiesArgs(), '-J', '--no-warnings', '--yes-playlist', targetUrl] });
      if (exitCode !== 0) throw classifyYtdlpFailure(stderr);

      const info: YtdlpPlaylistInfo = JSON.parse(stdout);

      if (info._type === 'playlist' && info.entries?.length) {
        return this.normalizeCarousel(info, targetUrl);
      }

      return normalizeYtdlpInfo(info, 'instagram', targetUrl);
    } catch (err) {
      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp failed for Instagram, trying fallback layers');
    }

    // Layer 3: btch-downloader, then cakkatrok as last resort.
    try {
      const items = await fetchInstagramViaBtchDownloader(targetUrl);
      return this.normalizeFallbackItems(
        items.map((i) => ({ url: i.url, type: guessExtFromUrl(i.url) === 'mp4' ? 'video' as const : 'image' as const, thumbnail: i.thumbnail })),
        targetUrl,
        'btch-downloader',
      );
    } catch (btchErr) {
      logger.warn({ requestId: ctx.requestId, err: (btchErr as Error).message }, 'btch-downloader failed, trying cakkatrok');
      const items = await fetchInstagramViaCakkatrok(targetUrl);
      return this.normalizeFallbackItems(items, targetUrl, 'cakkatrok-instagram-downloader');
    }
  }

  private normalizeCarousel(info: YtdlpPlaylistInfo, canonicalUrl: string): BlazfetchResponse {
    const items: BlazfetchItem[] = (info.entries ?? []).map((entry, idx) => {
      const { formats } = normalizeFormats(entry.formats ?? []);
      const isVideo = !!entry.formats?.length;
      return {
        id: entry.id ?? String(idx),
        type: isVideo ? 'video' : 'image',
        thumbnail: entry.thumbnail,
        source: !isVideo ? entry.thumbnail : undefined,
        durationSeconds: entry.duration,
        formats: isVideo ? formats : undefined,
      };
    });

    return {
      success: true,
      platform: 'instagram',
      mediaType: 'carousel',
      mediaId: info.id,
      canonicalUrl,
      title: info.title,
      description: info.description,
      author: { name: info.uploader ?? info.channel, url: info.uploader_url ?? info.channel_url },
      thumbnail: info.thumbnail ?? items[0]?.thumbnail,
      isCarousel: true,
      itemCount: items.length,
      items,
      formats: [],
      audioFormats: [],
      metadata: {},
      extractor: 'yt-dlp',
    };
  }

  private normalizeFallbackItems(
    items: { url: string; type: 'image' | 'video'; thumbnail?: string }[],
    canonicalUrl: string,
    fallbackUsed: string,
  ): BlazfetchResponse {
    if (items.length === 0) {
      throw new BlazfetchError('MEDIA_NOT_FOUND', 'No media could be extracted for this Instagram URL.');
    }

    const isCarousel = items.length > 1;
    const blazfetchItems: BlazfetchItem[] = items.map((item, idx) => ({
      id: String(idx),
      type: item.type,
      thumbnail: item.thumbnail,
      source: item.url,
      formats:
        item.type === 'video'
          ? [{ formatId: `${fallbackUsed}-${idx}`, ext: 'mp4', kind: 'video', url: item.url }]
          : undefined,
    }));

    return {
      success: true,
      platform: 'instagram',
      mediaType: isCarousel ? 'carousel' : items[0].type === 'video' ? 'video' : 'image',
      mediaId: canonicalUrl.split('/').filter(Boolean).pop() ?? 'unknown',
      canonicalUrl,
      thumbnail: items[0].thumbnail ?? (items[0].type === 'image' ? items[0].url : undefined),
      isCarousel,
      itemCount: items.length,
      items: isCarousel ? blazfetchItems : undefined,
      formats: !isCarousel && items[0].type === 'video' ? [{ formatId: `${fallbackUsed}-0`, ext: 'mp4', kind: 'video', url: items[0].url }] : [],
      audioFormats: [],
      metadata: {},
      extractor: 'fallback',
      fallbackUsed,
    };
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    try {
      return await this.delegate.download(ctx, target);
    } catch (err) {
      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp download failed for Instagram, using proxy-stream fallback');
      const metadata = await this.fetchMetadata(ctx);
      const flatFormats = metadata.formats.length ? metadata.formats : metadata.items?.flatMap((i) => i.formats ?? []) ?? [];
      const format = flatFormats.find((f) => f.formatId === target.formatId) ?? flatFormats[0];
      if (!format?.url) throw err;
      return {
        filePath: '',
        filename: `${metadata.mediaId}.${format.ext}`,
        mimeType: format.kind.startsWith('video') ? 'video/mp4' : 'image/jpeg',
        bytes: 0,
        directUrl: format.url,
      };
    }
  }
}
