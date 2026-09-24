import { BlazfetchError } from '../constants/errors';
import { detectPlatformFromHostname, PlatformId, TRACKING_PARAMS } from '../constants/platforms';
import { assertNotPrivateHost, assertSafeProtocol } from './ssrf';

export interface NormalizedUrlResult {
  platform: PlatformId;
  canonicalUrl: string;
  originalUrl: string;
  videoId?: string;
  playlistId?: string;
}

function ensureProtocol(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(ensureProtocol(raw));
  } catch {
    throw new BlazfetchError('INVALID_URL', 'The provided URL is malformed.');
  }
  try {
    assertSafeProtocol(url);
  } catch (err) {
    throw new BlazfetchError('INVALID_URL', (err as Error).message);
  }
  return url;
}

function stripTrackingParams(url: URL): void {
  const paramsToRemove: string[] = [];
  for (const key of url.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.includes(lower) || lower.startsWith('utm_')) {
      paramsToRemove.push(key);
    }
  }
  for (const key of paramsToRemove) url.searchParams.delete(key);

  const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of sorted) url.searchParams.append(key, value);
}

function normalizeYouTube(url: URL): { canonicalUrl: string; videoId?: string; playlistId?: string } {
  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  let videoId: string | undefined;
  const playlistId = url.searchParams.get('list') ?? undefined;

  if (host === 'youtu.be') {
    videoId = url.pathname.slice(1).split('/')[0];
  } else {
    const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)/);
    const liveMatch = url.pathname.match(/^\/live\/([^/]+)/);
    const embedMatch = url.pathname.match(/^\/embed\/([^/]+)/);
    const vMatch = url.pathname.match(/^\/v\/([^/]+)/);
    const eMatch = url.pathname.match(/^\/e\/([^/]+)/);
    if (shortsMatch) videoId = shortsMatch[1];
    else if (liveMatch) videoId = liveMatch[1];
    else if (embedMatch) videoId = embedMatch[1];
    else if (vMatch) videoId = vMatch[1];
    else if (eMatch) videoId = eMatch[1];
    else if (url.pathname === '/watch') videoId = url.searchParams.get('v') ?? undefined;
  }

  if (videoId) {
    const canonical = new URL('https://www.youtube.com/watch');
    canonical.searchParams.set('v', videoId);
    if (playlistId) canonical.searchParams.set('list', playlistId);
    return { canonicalUrl: canonical.toString(), videoId, playlistId };
  }

  if (playlistId && url.pathname.startsWith('/playlist')) {
    const canonical = new URL('https://www.youtube.com/playlist');
    canonical.searchParams.set('list', playlistId);
    return { canonicalUrl: canonical.toString(), playlistId };
  }

  const canonical = new URL(`https://www.youtube.com${url.pathname}`);
  canonical.search = url.search;
  return { canonicalUrl: canonical.toString() };
}

function normalizeInstagram(url: URL): { canonicalUrl: string } {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return { canonicalUrl: `https://www.instagram.com${path}` };
}

function normalizeTwitter(url: URL): { canonicalUrl: string } {
  if (url.hostname === 't.co') {
    return { canonicalUrl: url.toString() };
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return { canonicalUrl: `https://x.com${path}` };
}

function normalizeFacebook(url: URL): { canonicalUrl: string } {
  if (url.hostname.replace(/^www\./, '') === 'fb.watch') {
    return { canonicalUrl: url.toString() };
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const canonical = new URL(`https://www.facebook.com${path}`);
  canonical.search = url.search;
  return { canonicalUrl: canonical.toString() };
}

function normalizeReddit(url: URL): { canonicalUrl: string } {
  if (url.hostname === 'redd.it') {
    return { canonicalUrl: url.toString() };
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return { canonicalUrl: `https://www.reddit.com${path}` };
}

function normalizePinterest(url: URL): { canonicalUrl: string } {
  if (url.hostname === 'pin.it') {
    return { canonicalUrl: url.toString() };
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return { canonicalUrl: `https://www.pinterest.com${path}` };
}

const SOUNDCLOUD_NON_TRACK_SEGMENTS = new Set(['you', 'stream', 'discover', 'search', 'upload', 'charts', 'stations']);

/**
 * A single track/set URL has at least two path segments (/user/track or /user/sets/name).
 * A bare profile URL (/user) has one segment and, if passed to yt-dlp, gets treated as a
 * "channel" extraction that enumerates the user's entire upload history — which is slow (or
 * times out) and isn't what "fetch this SoundCloud link" means. Reject it before it ever
 * reaches yt-dlp, same as an unsupported platform would be rejected.
 */
function normalizeSoundCloud(url: URL): { canonicalUrl: string } {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0 || SOUNDCLOUD_NON_TRACK_SEGMENTS.has(segments[0].toLowerCase())) {
    throw new BlazfetchError('INVALID_URL', 'This looks like a SoundCloud profile or browse page, not a single track. Provide a link to one track or set.');
  }
  if (segments.length < 2) {
    throw new BlazfetchError('INVALID_URL', 'This looks like a SoundCloud profile page, not a single track. Provide a link to one track or set.');
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return { canonicalUrl: `https://soundcloud.com${path}` };
}

function normalizeDailymotion(url: URL): { canonicalUrl: string } {
  const embedMatch = url.pathname.match(/^\/embed\/video\/([^/?]+)/);
  if (embedMatch) {
    return { canonicalUrl: `https://www.dailymotion.com/video/${embedMatch[1]}` };
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return { canonicalUrl: `https://www.dailymotion.com${path}` };
}

function genericNormalize(url: URL): { canonicalUrl: string } {
  const path = url.pathname.replace(/\/+(?=$)/, '') || '/';
  const canonical = new URL(`${url.protocol}//${url.hostname}${path}`);
  canonical.search = url.search;
  return { canonicalUrl: canonical.toString() };
}

/**
 * Validates, normalizes, and detects the platform for an incoming URL.
 * Throws BlazfetchError(UNSUPPORTED_PLATFORM | INVALID_URL) on failure.
 */
export function validateAndNormalizeUrl(raw: string): NormalizedUrlResult {
  if (!raw || typeof raw !== 'string') {
    throw new BlazfetchError('INVALID_URL', 'A URL is required.');
  }

  const url = parseUrl(raw);
  url.hash = '';
  stripTrackingParams(url);

  const platform = detectPlatformFromHostname(url.hostname);
  if (!platform) {
    throw new BlazfetchError('UNSUPPORTED_PLATFORM', 'This platform is currently not supported.');
  }

  let result: { canonicalUrl: string; videoId?: string; playlistId?: string };
  switch (platform) {
    case 'youtube':
      result = normalizeYouTube(url);
      break;
    case 'instagram':
      result = normalizeInstagram(url);
      break;
    case 'twitter':
      result = normalizeTwitter(url);
      break;
    case 'facebook':
      result = normalizeFacebook(url);
      break;
    case 'reddit':
      result = normalizeReddit(url);
      break;
    case 'pinterest':
      result = normalizePinterest(url);
      break;
    case 'soundcloud':
      result = normalizeSoundCloud(url);
      break;
    case 'dailymotion':
      result = normalizeDailymotion(url);
      break;
    default:
      result = genericNormalize(url);
  }

  return {
    platform,
    canonicalUrl: result.canonicalUrl,
    originalUrl: raw,
    videoId: result.videoId,
    playlistId: result.playlistId,
  };
}

/** Guards against SSRF before the backend makes any outbound request to a resolved URL. */
export async function assertUrlIsSafeToFetch(raw: string): Promise<URL> {
  const url = parseUrl(raw);
  await assertNotPrivateHost(url.hostname);
  return url;
}
