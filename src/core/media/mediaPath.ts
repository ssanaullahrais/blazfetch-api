import { PLATFORMS, PlatformId } from '../../constants/platforms';
import { NormalizedUrlResult } from '../../utils/url';
import { BlazfetchResponse } from '../../types/blazfetch';

/**
 * Stable, human-readable identity for stored media.
 *
 * - A stored row is keyed by (platform, mediaKey). An item's key is its platform id (`Cwkej79U3ek`);
 *   a playlist's key is `playlist:<id>`, so both live in one table without any extra unique index.
 * - The public path mirrors the key: `/youtube/Cwkej79U3ek` for an item and
 *   `/youtube/Cwkej79U3ek/playlist/RDCwkej79U3ek` (or `/youtube/playlist/<id>`) for a playlist.
 */

export type MediaKind = 'video' | 'playlist';

export const PLAYLIST_PREFIX = 'playlist:';

export function playlistKey(playlistId: string): string {
  return `${PLAYLIST_PREFIX}${playlistId}`;
}

export function kindOfKey(mediaKey: string): MediaKind {
  return mediaKey.startsWith(PLAYLIST_PREFIX) ? 'playlist' : 'video';
}

export function idOfKey(mediaKey: string): string {
  return mediaKey.startsWith(PLAYLIST_PREFIX) ? mediaKey.slice(PLAYLIST_PREFIX.length) : mediaKey;
}

/** The key a stored row uses for an already-extracted response. */
export function mediaKeyForResponse(response: Pick<BlazfetchResponse, 'mediaId' | 'mediaType' | 'isPlaylist'>): string {
  const isPlaylist = response.isPlaylist === true || response.mediaType === 'playlist';
  return isPlaylist && !response.mediaId.startsWith(PLAYLIST_PREFIX) ? playlistKey(response.mediaId) : response.mediaId;
}

/**
 * The key we can predict from the URL alone, before any extraction. Only YouTube exposes its ids in
 * the URL; for every other platform the id is learned from the extraction, so lookups use the URL.
 */
export function predictedMediaKey(normalized: NormalizedUrlResult): string | undefined {
  if (normalized.platform !== 'youtube') return undefined;
  if (normalized.videoId) return normalized.videoId;
  if (normalized.playlistId) return playlistKey(normalized.playlistId);
  return undefined;
}

/** YouTube "Mix" playlists (RD...) are generated per viewer and change constantly, so they refresh often. */
export function isMixPlaylist(platform: string, mediaKey: string): boolean {
  return platform === 'youtube' && kindOfKey(mediaKey) === 'playlist' && idOfKey(mediaKey).startsWith('RD');
}

const seg = (value: string): string => encodeURIComponent(value);

export function buildMediaPath(platform: string, mediaKey: string, contextItemId?: string): string {
  if (kindOfKey(mediaKey) === 'playlist') {
    const listId = seg(idOfKey(mediaKey));
    return contextItemId ? `/${platform}/${seg(contextItemId)}/playlist/${listId}` : `/${platform}/playlist/${listId}`;
  }
  return `/${platform}/${seg(mediaKey)}`;
}

export interface ParsedMediaPath {
  platform: PlatformId;
  mediaKey: string;
  /** The item shown alongside a playlist (the `X` in `/youtube/X/playlist/Y`), when the path had one. */
  contextItemId?: string;
}

const PLATFORM_IDS = new Set<string>(PLATFORMS.map((p) => p.id));

/** Parses `/youtube/<id>`, `/youtube/<id>/playlist/<listId>` or `/youtube/playlist/<listId>`. */
export function parseMediaPath(pathname: string): ParsedMediaPath | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }

  const [platform, ...rest] = decoded;
  if (!PLATFORM_IDS.has(platform)) return null;
  // eslint-disable-next-line no-control-regex -- deliberately rejecting control characters, not a typo
  const valid = (v: string | undefined): v is string => !!v && v.length <= 255 && !/[\u0000-\u001f]/.test(v);

  if (rest.length === 1 && rest[0] !== 'playlist' && valid(rest[0])) {
    return { platform: platform as PlatformId, mediaKey: rest[0] };
  }
  if (rest.length === 2 && rest[0] === 'playlist' && valid(rest[1])) {
    return { platform: platform as PlatformId, mediaKey: playlistKey(rest[1]) };
  }
  if (rest.length === 3 && rest[1] === 'playlist' && valid(rest[0]) && valid(rest[2])) {
    return { platform: platform as PlatformId, mediaKey: playlistKey(rest[2]), contextItemId: rest[0] };
  }
  return null;
}

/**
 * Rebuilds a fetchable source URL from a key, so a pretty link to something never fetched before can
 * still be resolved. Only platforms whose id alone identifies the media are listed; for the rest
 * (Bluesky needs the handle, Reddit the subreddit, Tumblr the blog) it returns undefined and only
 * already-stored items can be served.
 */
export function sourceUrlForKey(platform: string, mediaKey: string): string | undefined {
  const id = idOfKey(mediaKey);
  const enc = encodeURIComponent(id);

  if (kindOfKey(mediaKey) === 'playlist') {
    return platform === 'youtube' ? `https://www.youtube.com/playlist?list=${enc}` : undefined;
  }

  switch (platform) {
    case 'youtube':
      return `https://www.youtube.com/watch?v=${enc}`;
    case 'vimeo':
      return /^\d+$/.test(id) ? `https://vimeo.com/${id}` : undefined;
    case 'dailymotion':
      return `https://www.dailymotion.com/video/${enc}`;
    case 'twitch':
      return /^\d+$/.test(id) ? `https://www.twitch.tv/videos/${id}` : undefined;
    case 'streamable':
      return `https://streamable.com/${enc}`;
    case 'loom':
      return `https://www.loom.com/share/${enc}`;
    case 'newgrounds':
      return /^\d+$/.test(id) ? `https://www.newgrounds.com/portal/view/${id}` : undefined;
    case 'pinterest':
      return /^\d+$/.test(id) ? `https://www.pinterest.com/pin/${id}/` : undefined;
    case 'rutube':
      return `https://rutube.ru/video/${enc}/`;
    case 'instagram':
      return `https://www.instagram.com/p/${enc}/`;
    case 'twitter':
      return /^\d+$/.test(id) ? `https://x.com/i/status/${id}` : undefined;
    case 'tiktok':
      return /^\d+$/.test(id) ? `https://www.tiktok.com/@/video/${id}` : undefined;
    case 'facebook':
      return /^\d+$/.test(id) ? `https://www.facebook.com/watch/?v=${id}` : undefined;
    case 'snapchat':
      return `https://www.snapchat.com/spotlight/${enc}`;
    case 'soundcloud':
      return /^\d+$/.test(id) ? `https://api.soundcloud.com/tracks/${id}` : undefined;
    default:
      return undefined;
  }
}
