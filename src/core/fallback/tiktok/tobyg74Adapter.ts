import { BlazfetchError } from '../../../constants/errors';
import { BlazfetchFormat, BlazfetchResponse } from '../../../types/blazfetch';

// @tobyg74/tiktok-api-dl has no bundled TypeScript types; the shape below reflects its
// documented v1/v3 downloader response and is treated as untrusted external data.
interface TobyG74Result {
  status: 'success' | 'error';
  message?: string;
  result?: {
    type?: 'video' | 'image';
    id?: string;
    author?: { username?: string; nickname?: string };
    desc?: string;
    // Each of these has been seen as a plain link, a list of links, or an object holding them (for example
    // `video: { playAddr: [...] }` and `music: { playUrl: [...] }` in current releases): read with linkFrom.
    videoHD?: unknown;
    videoWatermark?: unknown;
    video?: unknown;
    images?: unknown[];
    music?: unknown;
    cover?: unknown;
  };
}

const LINK_KEYS = ['playAddr', 'playUrl', 'downloadAddr', 'url', 'urlList', 'url_list', 'uri'];

/** The first http(s) link in a provider value, whichever of those shapes it has. */
export function linkFrom(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || value == null) return undefined;
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const link = linkFrom(entry, depth + 1);
      if (link) return link;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    for (const key of LINK_KEYS) {
      const link = linkFrom((value as Record<string, unknown>)[key], depth + 1);
      if (link) return link;
    }
  }
  return undefined;
}

/**
 * TikTok fallback used when yt-dlp fails (anti-bot changes, extractor breakage).
 * Normalizes into the exact same Blazfetch response shape as the primary yt-dlp path.
 */
export async function fetchTiktokViaTobyG74(url: string): Promise<BlazfetchResponse> {
  let TiktokDL: { Downloader: (url: string, opts?: Record<string, unknown>) => Promise<TobyG74Result> };
  try {
    TiktokDL = (await import('@tobyg74/tiktok-api-dl')).default as typeof TiktokDL;
  } catch {
    throw new BlazfetchError('EXTRACTOR_FAILED', 'TikTok fallback provider is not installed.');
  }

  const response = await TiktokDL.Downloader(url, { version: 'v1' });
  if (response.status !== 'success' || !response.result) {
    throw new BlazfetchError('EXTRACTOR_FAILED', response.message ?? 'TikTok fallback provider failed.');
  }

  const { result } = response;
  const formats: BlazfetchFormat[] = [];
  const hd = linkFrom(result.videoHD);
  const sd = linkFrom(result.video);
  const watermarked = linkFrom(result.videoWatermark);
  if (hd) formats.push({ formatId: 'hd', ext: 'mp4', kind: 'video', quality: 'HD', url: hd });
  if (sd && sd !== hd) formats.push({ formatId: 'sd', ext: 'mp4', kind: 'video', quality: 'SD', url: sd });
  if (watermarked && formats.length === 0) {
    formats.push({ formatId: 'watermark', ext: 'mp4', kind: 'video', quality: 'SD (watermarked)', url: watermarked });
  }
  const images = (result.images ?? []).map((image) => linkFrom(image)).filter((link): link is string => !!link);
  const music = linkFrom(result.music);

  if (formats.length === 0 && !images.length) {
    throw new BlazfetchError('MEDIA_NOT_FOUND', 'TikTok fallback returned no usable media.');
  }

  return {
    success: true,
    platform: 'tiktok',
    mediaType: images.length ? 'carousel' : 'video',
    mediaId: result.id ?? 'unknown',
    canonicalUrl: url,
    title: result.desc,
    author: { name: result.author?.nickname ?? result.author?.username, url: result.author?.username ? `https://www.tiktok.com/@${result.author.username}` : undefined },
    thumbnail: linkFrom(result.cover),
    items: images.length ? images.map((src, idx) => ({ id: String(idx), type: 'image' as const, source: src })) : undefined,
    isCarousel: images.length > 0,
    itemCount: images.length || undefined,
    formats,
    audioFormats: music ? [{ formatId: 'original', ext: 'mp3', isConverted: false, url: music }] : [],
    metadata: {},
    extractor: 'tobyg74/tiktok-api-dl',
    fallbackUsed: 'tobyg74',
  };
}
