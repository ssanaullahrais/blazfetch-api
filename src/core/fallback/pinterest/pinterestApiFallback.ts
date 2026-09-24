import { BlazfetchError } from '../../../constants/errors';
import { assertUrlIsSafeToFetch } from '../../../utils/url';
import { env } from '../../../config/env';

/**
 * Pinterest's own `PinResource` API — the same endpoint yt-dlp's Pinterest extractor calls
 * (see PinterestBaseIE._call_api / PinterestIE._real_extract) — is fully public: no cookies,
 * no login, no signed request. The catch is the `field_set_key` query param: yt-dlp uses
 * 'unauth_react_main_pin', which is the field set that actually includes `videos`/
 * `story_pin_data`. Other field sets (e.g. 'detailed') omit those fields entirely even for a
 * real video pin, which is why a naive request can look like "this pin has no video" when it's
 * really just the wrong field set. The returned MP4 CDN URLs (v1.pinimg.com) carry no query
 * string / signature and don't expire — confirmed against a live pin.
 */

interface PinterestVideoListEntry {
  url: string;
  width?: number;
  height?: number;
  duration?: number;
}

interface PinterestResourceData {
  id: string;
  is_video?: boolean;
  title?: string;
  grid_title?: string;
  videos?: { video_list?: Record<string, PinterestVideoListEntry> };
  story_pin_data?: { pages?: { blocks?: { video?: { video_list?: Record<string, PinterestVideoListEntry> } }[] }[] };
  images?: Record<string, { url?: string; width?: number; height?: number }>;
}

export interface PinterestFallbackResult {
  mediaId: string;
  title?: string;
  thumbnail?: string;
  mp4Url?: string;
  mp4Width?: number;
  mp4Height?: number;
  hlsUrl?: string;
  durationSeconds?: number;
}

async function callPinResourceApi(pinId: string): Promise<PinterestResourceData> {
  const apiUrl = new URL('https://www.pinterest.com/resource/PinResource/get/');
  apiUrl.searchParams.set('data', JSON.stringify({ options: { field_set_key: 'unauth_react_main_pin', id: pinId } }));

  await assertUrlIsSafeToFetch(apiUrl.toString());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.FALLBACK_TIMEOUT_MS);

  try {
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        'X-Pinterest-PWS-Handler': 'www/[username].js',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new BlazfetchError('EXTRACTOR_FAILED', `Pinterest resource API responded with ${res.status}.`);
    }
    const body = (await res.json()) as { resource_response?: { data?: PinterestResourceData } };
    const data = body.resource_response?.data;
    if (!data) {
      throw new BlazfetchError('MEDIA_NOT_FOUND', 'Pinterest resource API returned no pin data.');
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function findVideoList(data: PinterestResourceData): Record<string, PinterestVideoListEntry> | undefined {
  if (data.videos?.video_list) return data.videos.video_list;
  for (const page of data.story_pin_data?.pages ?? []) {
    for (const block of page.blocks ?? []) {
      if (block.video?.video_list) return block.video.video_list;
    }
  }
  return undefined;
}

function largestThumbnail(images: PinterestResourceData['images']): string | undefined {
  if (!images) return undefined;
  const entries = Object.values(images).filter((i): i is { url: string; width?: number; height?: number } => !!i?.url);
  return entries.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
}

export async function fetchPinterestViaResourceApi(pinId: string): Promise<PinterestFallbackResult> {
  const data = await callPinResourceApi(pinId);
  const videoList = findVideoList(data);

  if (!videoList || Object.keys(videoList).length === 0) {
    throw new BlazfetchError('MEDIA_NOT_FOUND', 'This Pinterest pin has no video (it is an image-only pin).');
  }

  let mp4: { url: string; width?: number; height?: number; duration?: number } | undefined;
  let hlsUrl: string | undefined;
  let durationSeconds: number | undefined;

  for (const [formatId, entry] of Object.entries(videoList)) {
    if (!entry?.url) continue;
    durationSeconds ??= entry.duration ? entry.duration / 1000 : undefined;
    const isHls = formatId.toLowerCase().includes('hls') || entry.url.endsWith('.m3u8');
    if (isHls) {
      hlsUrl ??= entry.url;
    } else if (!mp4 || (entry.width ?? 0) > (mp4.width ?? 0)) {
      mp4 = { url: entry.url, width: entry.width, height: entry.height, duration: entry.duration };
    }
  }

  return {
    mediaId: data.id,
    title: data.title || data.grid_title,
    thumbnail: largestThumbnail(data.images),
    mp4Url: mp4?.url,
    mp4Width: mp4?.width,
    mp4Height: mp4?.height,
    hlsUrl,
    durationSeconds,
  };
}

/** Resolves a pin.it short link to its canonical pinterest.com/pin/<id> URL via HTTP redirect. */
export async function resolvePinItRedirect(pinItUrl: string): Promise<string> {
  await assertUrlIsSafeToFetch(pinItUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.REDIRECT_RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(pinItUrl, { redirect: 'follow', signal: controller.signal });
    return res.url || pinItUrl;
  } finally {
    clearTimeout(timer);
  }
}
