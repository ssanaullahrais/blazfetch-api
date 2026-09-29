import { env } from '../../../config/env';
import { BlazfetchError } from '../../../constants/errors';
import { BlazfetchResponse, BlazfetchPlaylistItem } from '../../../types/blazfetch';

interface Snippet {
  title?: string; channelTitle?: string;
  thumbnails?: Record<string, { url?: string }>;
  resourceId?: { videoId?: string };
}

async function request(resource: string, params: Record<string, string>, signal: AbortSignal) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  url.search = new URLSearchParams({ ...params, key: env.YOUTUBE_DATA_API_KEY }).toString();
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok) throw new BlazfetchError('EXTRACTOR_FAILED', 'YouTube playlist API could not list this playlist.');
  return response.json() as Promise<{ items?: { snippet?: Snippet; contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>;
}

/** Official playlist enumeration is independent of the video extractor; it never supplies video bytes. */
export async function fetchPlaylistViaApi(playlistId: string, canonicalUrl: string): Promise<BlazfetchResponse> {
  if (!env.YOUTUBE_DATA_API_KEY) throw new BlazfetchError('EXTRACTOR_FAILED', 'YouTube playlist fallback is not configured.');
  const signal = AbortSignal.timeout(env.FETCH_TIMEOUT_MS);
  try {
    const info = await request('playlists', { part: 'snippet', id: playlistId }, signal);
    const snippet = info.items?.[0]?.snippet;
    if (!snippet) throw new BlazfetchError('MEDIA_NOT_FOUND', 'This public playlist could not be found.');
    const items: BlazfetchPlaylistItem[] = [];
    const seenPages = new Set<string>();
    let pageToken = '';
    do {
      if (seenPages.has(pageToken)) throw new BlazfetchError('EXTRACTOR_FAILED', 'YouTube returned a repeated playlist page.');
      seenPages.add(pageToken);
      const page = await request('playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: String(Math.min(50, env.MAX_PLAYLIST_ITEMS - items.length)), ...(pageToken ? { pageToken } : {}) }, signal);
      if (!Array.isArray(page.items)) throw new BlazfetchError('EXTRACTOR_FAILED', 'YouTube returned an invalid playlist page.');
      for (const item of page.items) {
        const id = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
        if (id && /^[\w-]{11}$/.test(id)) items.push({ videoId: id, title: item.snippet?.title ?? id, thumbnail: thumbnail(item.snippet), url: `https://www.youtube.com/watch?v=${id}` });
        if (items.length >= env.MAX_PLAYLIST_ITEMS) break;
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken && items.length < env.MAX_PLAYLIST_ITEMS);
    return { success: true, platform: 'youtube', mediaType: 'playlist', mediaId: playlistId, canonicalUrl, title: snippet.title, thumbnail: thumbnail(snippet), isPlaylist: true, itemCount: items.length, playlist: { title: snippet.title, channel: snippet.channelTitle, thumbnail: thumbnail(snippet), itemCount: items.length, items }, formats: [], audioFormats: [], metadata: { playlistLimit: env.MAX_PLAYLIST_ITEMS, playlistTruncated: !!pageToken }, extractor: 'youtube-data-api', fallbackUsed: 'youtube-data-api' };
  } catch (error) {
    if (error instanceof BlazfetchError) throw error;
    throw new BlazfetchError('EXTRACTOR_FAILED', 'YouTube playlist API request failed.');
  }
}

function thumbnail(snippet?: Snippet): string | undefined {
  return snippet?.thumbnails?.maxres?.url ?? snippet?.thumbnails?.high?.url ?? snippet?.thumbnails?.default?.url;
}
