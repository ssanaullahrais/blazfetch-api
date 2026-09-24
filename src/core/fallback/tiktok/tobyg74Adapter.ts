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
    videoHD?: string;
    videoWatermark?: string;
    video?: string;
    images?: string[];
    music?: string;
    cover?: string;
  };
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
  if (result.videoHD) {
    formats.push({ formatId: 'hd', ext: 'mp4', kind: 'video', quality: 'HD', url: result.videoHD });
  }
  if (result.video) {
    formats.push({ formatId: 'sd', ext: 'mp4', kind: 'video', quality: 'SD', url: result.video });
  }
  if (result.videoWatermark && formats.length === 0) {
    formats.push({ formatId: 'watermark', ext: 'mp4', kind: 'video', quality: 'SD (watermarked)', url: result.videoWatermark });
  }

  if (formats.length === 0 && !result.images?.length) {
    throw new BlazfetchError('MEDIA_NOT_FOUND', 'TikTok fallback returned no usable media.');
  }

  return {
    success: true,
    platform: 'tiktok',
    mediaType: result.images?.length ? 'carousel' : 'video',
    mediaId: result.id ?? 'unknown',
    canonicalUrl: url,
    title: result.desc,
    author: { name: result.author?.nickname ?? result.author?.username, url: result.author?.username ? `https://www.tiktok.com/@${result.author.username}` : undefined },
    thumbnail: result.cover,
    items: result.images?.map((src, idx) => ({ id: String(idx), type: 'image' as const, source: src })),
    isCarousel: !!result.images?.length,
    itemCount: result.images?.length,
    formats,
    audioFormats: result.music ? [{ formatId: 'original', ext: 'mp3', isConverted: false, url: result.music }] : [],
    metadata: {},
    extractor: 'tobyg74/tiktok-api-dl',
    fallbackUsed: 'tobyg74',
  };
}
