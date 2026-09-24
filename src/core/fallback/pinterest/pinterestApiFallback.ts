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

function extractVideoOrImage(data: PinterestResourceData): {
  type: 'video' | 'image';
  mp4Url?: string;
  mp4Width?: number;
  mp4Height?: number;
  hlsUrl?: string;
  durationSeconds?: number;
  thumbnail?: string;
} {
  const videoList = findVideoList(data);
  const thumbnail = largestThumbnail(data.images);

  if (!videoList || Object.keys(videoList).length === 0) {
    return { type: 'image', thumbnail };
  }

  let mp4: { url: string; width?: number; height?: number } | undefined;
  let hlsUrl: string | undefined;
  let durationSeconds: number | undefined;
  for (const [formatId, entry] of Object.entries(videoList)) {
    if (!entry?.url) continue;
    durationSeconds ??= entry.duration ? entry.duration / 1000 : undefined;
    const isHls = formatId.toLowerCase().includes('hls') || entry.url.endsWith('.m3u8');
    if (isHls) hlsUrl ??= entry.url;
    else if (!mp4 || (entry.width ?? 0) > (mp4.width ?? 0)) mp4 = { url: entry.url, width: entry.width, height: entry.height };
  }

  return { type: 'video', mp4Url: mp4?.url, mp4Width: mp4?.width, mp4Height: mp4?.height, hlsUrl, durationSeconds, thumbnail };
}

interface PinterestBoardResourceData {
  id: string;
  name?: string;
  pin_count?: number;
  image_thumbnail_url?: string;
}

export interface PinterestBoardItem {
  pinId: string;
  type: 'video' | 'image';
  thumbnail?: string;
  mp4Url?: string;
  mp4Width?: number;
  mp4Height?: number;
  hlsUrl?: string;
  durationSeconds?: number;
}

export interface PinterestBoardResult {
  boardId: string;
  boardName?: string;
  thumbnail?: string;
  totalPinCount?: number;
  items: PinterestBoardItem[];
  rangeStart: number;
  rangeEnd: number;
  truncated: boolean;
}

async function callPinterestApi<T>(resource: string, options: Record<string, unknown>): Promise<{ data: T; bookmark?: string }> {
  const apiUrl = new URL(`https://www.pinterest.com/resource/${resource}Resource/get/`);
  apiUrl.searchParams.set('data', JSON.stringify({ options }));

  await assertUrlIsSafeToFetch(apiUrl.toString());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.FALLBACK_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        'X-Pinterest-PWS-Handler': 'www/[username]/[slug].js',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new BlazfetchError('EXTRACTOR_FAILED', `Pinterest ${resource} API responded with ${res.status}.`);
    }
    const body = (await res.json()) as { resource_response?: { data?: T; bookmark?: string } };
    if (!body.resource_response?.data) {
      throw new BlazfetchError('MEDIA_NOT_FOUND', `Pinterest ${resource} API returned no data.`);
    }
    return { data: body.resource_response.data, bookmark: body.resource_response.bookmark };
  } finally {
    clearTimeout(timer);
  }
}

export interface PinterestBoardRange {
  /** 1-based, inclusive. Defaults to the start/end of the board. */
  start?: number;
  end?: number;
}

/**
 * Lists pins in a public Pinterest board (unauthenticated, same public BoardResource /
 * BoardFeedResource endpoints yt-dlp's PinterestCollectionIE uses), resolving each pin's video
 * or largest-image source directly from the feed response — no extra per-pin API call needed,
 * since the feed already returns full pin objects in the same shape as PinResource.
 *
 * Pinterest's feed pagination is cursor-based (an opaque bookmark token), not offset-based, so
 * there's no way to jump straight to item 50 — pages are walked sequentially from the start and
 * everything before `range.start` is discarded. Requesting items 950-1000 of a huge board is
 * therefore just as slow as requesting 1-1000; that's an inherent limit of Pinterest's API, not
 * something a smarter query can avoid.
 */
export async function fetchPinterestBoard(username: string, slug: string, maxItems: number, range?: PinterestBoardRange): Promise<PinterestBoardResult> {
  const { data: board } = await callPinterestApi<PinterestBoardResourceData>('Board', { username, slug, field_set_key: 'grid_item' });

  const rangeStart = Math.max(1, range?.start ?? 1);
  const rangeEnd = Math.max(rangeStart, range?.end ?? rangeStart + maxItems - 1);
  const windowSize = rangeEnd - rangeStart + 1;
  if (windowSize > maxItems) {
    throw new BlazfetchError('VALIDATION_ERROR', `Requested range spans ${windowSize} pins, which exceeds the ${maxItems} pin limit per request.`);
  }

  const items: PinterestBoardItem[] = [];
  let bookmark: string | undefined;
  let truncated = false;
  let seen = 0;

  while (seen < rangeEnd) {
    const pageSize = 25;
    const options: Record<string, unknown> = { board_id: board.id, page_size: pageSize };
    if (bookmark) options.bookmarks = [bookmark];

    const { data: feedItems, bookmark: nextBookmark } = await callPinterestApi<PinterestResourceData[]>('BoardFeed', options);
    const pins = (feedItems as unknown as (PinterestResourceData & { type?: string })[]).filter((i) => i.type === 'pin' || i.id);

    for (const pin of pins) {
      seen += 1;
      if (seen < rangeStart || seen > rangeEnd) continue;
      const resolved = extractVideoOrImage(pin);
      items.push({
        pinId: pin.id,
        type: resolved.type,
        thumbnail: resolved.thumbnail,
        mp4Url: resolved.mp4Url,
        mp4Width: resolved.mp4Width,
        mp4Height: resolved.mp4Height,
        hlsUrl: resolved.hlsUrl,
        durationSeconds: resolved.durationSeconds,
      });
    }

    if (seen >= rangeEnd) break;
    if (!nextBookmark || nextBookmark === '-end-' || pins.length === 0) {
      truncated = seen < rangeEnd;
      break;
    }
    bookmark = nextBookmark;
  }

  return {
    boardId: board.id,
    boardName: board.name,
    thumbnail: board.image_thumbnail_url,
    totalPinCount: board.pin_count,
    items,
    rangeStart,
    rangeEnd: Math.min(rangeEnd, seen),
    truncated,
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
