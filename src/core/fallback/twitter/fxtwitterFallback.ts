import { BlazfetchError } from '../../../constants/errors';
import { BlazfetchFormat, BlazfetchResponse } from '../../../types/blazfetch';
import { safeFetch } from '../../../utils/safeFetch';
import { env } from '../../../config/env';

/**
 * X/Twitter fallback for posts yt-dlp cannot see ("No video could be found in this tweet"): X hides some media from
 * anonymous requests, but the public FixTweet API (api.fxtwitter.com) still lists the video's direct MP4 links.
 * Third-party data, so every field is treated as untrusted; the links point at video.twimg.com.
 */

interface FxVariant {
  url?: string;
  bitrate?: number;
  container?: string;
  codec?: string;
}

interface FxVideo {
  url?: string;
  thumbnail_url?: string;
  duration?: number;
  width?: number;
  height?: number;
  type?: string;
  formats?: FxVariant[];
}

interface FxTweet {
  id?: string;
  text?: string;
  author?: { screen_name?: string; name?: string; url?: string };
  media?: { videos?: FxVideo[] };
}

/** `…/vid/avc1/720x780/file.mp4` carries the variant's size. */
function sizeFromUrl(url: string): { width?: number; height?: number } {
  const match = url.match(/\/(\d{2,5})x(\d{2,5})\//);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : {};
}

function isTwimgMp4(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)twimg\.com$/i.test(parsed.hostname) && /\.mp4$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function tweetIdFromUrl(url: string): string | undefined {
  return url.match(/\/status(?:es)?\/(\d{5,25})/)?.[1];
}

export async function fetchTwitterViaFxTwitter(canonicalUrl: string): Promise<BlazfetchResponse> {
  const id = tweetIdFromUrl(canonicalUrl);
  if (!id) throw new BlazfetchError('INVALID_URL', 'This does not look like a link to a single post.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.FALLBACK_TIMEOUT_MS);
  let tweet: FxTweet | undefined;
  try {
    const res = await safeFetch(`https://api.fxtwitter.com/status/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlazFetch)', Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 404) throw new BlazfetchError('MEDIA_NOT_FOUND', 'This post could not be found (deleted, private or suspended).');
    if (!res.ok) throw new BlazfetchError('EXTRACTOR_FAILED', `The X fallback provider answered ${res.status}.`);
    tweet = ((await res.json()) as { tweet?: FxTweet }).tweet;
  } catch (err) {
    if (err instanceof BlazfetchError) throw err;
    throw new BlazfetchError('EXTRACTOR_FAILED', 'The X fallback provider could not be reached.');
  } finally {
    clearTimeout(timer);
  }

  const video = tweet?.media?.videos?.[0];
  const variants = (video?.formats ?? []).filter((v) => v.container === 'mp4' && isTwimgMp4(v.url));
  const single = isTwimgMp4(video?.url) ? [{ url: video?.url, bitrate: undefined, container: 'mp4', codec: 'h264' } as FxVariant] : [];
  const candidates = variants.length ? variants : single;
  if (!tweet || !video || candidates.length === 0) {
    throw new BlazfetchError('MEDIA_NOT_FOUND', 'This post has no video that can be downloaded.');
  }

  const formats: BlazfetchFormat[] = [];
  const seen = new Set<string>();
  for (const variant of candidates) {
    const url = variant.url as string;
    const { width, height } = sizeFromUrl(url);
    const formatId = `fx-${height ?? variant.bitrate ?? formats.length}`;
    if (seen.has(formatId)) continue;
    seen.add(formatId);
    formats.push({
      formatId,
      ext: 'mp4',
      kind: 'video',
      quality: width && height ? `${width}x${height}` : undefined,
      width,
      height,
      bitrate: variant.bitrate ? Math.round(variant.bitrate / 1000) : undefined,
      codec: variant.codec ?? 'h264',
      url,
      requiresMerge: false,
      compatible: true,
    });
  }
  formats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

  const author = tweet.author;
  return {
    success: true,
    platform: 'twitter',
    mediaType: 'video',
    mediaId: tweet.id ?? id,
    canonicalUrl,
    title: [author?.name, tweet.text].filter(Boolean).join(' - ').slice(0, 200) || undefined,
    description: tweet.text,
    author: { name: author?.name ?? author?.screen_name, url: author?.url },
    thumbnail: video.thumbnail_url,
    durationSeconds: video.duration ? Math.round(video.duration) : undefined,
    formats,
    audioFormats: [],
    metadata: {},
    extractor: 'fxtwitter',
    fallbackUsed: 'fxtwitter',
  } as BlazfetchResponse;
}
