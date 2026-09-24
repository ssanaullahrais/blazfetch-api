import { PlatformId } from '../constants/platforms';

export type MediaType = 'video' | 'audio' | 'image' | 'carousel' | 'playlist';

export interface BlazfetchFormat {
  formatId: string;
  ext: string;
  kind: 'video' | 'audio' | 'video_only' | 'audio_only';
  quality?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  codec?: string;
  filesizeBytes?: number;
  filesizeApprox?: boolean;
  url?: string;
  requiresMerge?: boolean;
  /** True when the codec is broadly browser/device-compatible (H.264 video / AAC audio) without transcoding. */
  compatible?: boolean;
}

export interface BlazfetchAudioFormat {
  formatId: string;
  ext: string;
  bitrate?: number;
  codec?: string;
  quality?: string;
  durationSeconds?: number;
  filesizeBytes?: number;
  filesizeApprox?: boolean;
  isConverted: boolean;
  url?: string;
}

export interface BlazfetchAuthor {
  name?: string;
  url?: string;
}

export interface BlazfetchItem {
  id: string;
  type: 'image' | 'video';
  thumbnail?: string;
  source?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  formats?: BlazfetchFormat[];
}

export interface BlazfetchPlaylistItem {
  videoId: string;
  title: string;
  thumbnail?: string;
  durationSeconds?: number;
  url: string;
}

export interface BlazfetchResponse {
  success: true;
  platform: PlatformId;
  mediaType: MediaType;
  mediaId: string;
  canonicalUrl: string;
  title?: string;
  description?: string;
  author?: BlazfetchAuthor;
  thumbnail?: string;
  durationSeconds?: number | null;
  uploadDate?: string;
  items?: BlazfetchItem[];
  formats: BlazfetchFormat[];
  audioFormats: BlazfetchAudioFormat[];
  isPlaylist?: boolean;
  isCarousel?: boolean;
  itemCount?: number;
  playlist?: {
    title?: string;
    thumbnail?: string;
    channel?: string;
    itemCount: number;
    items: BlazfetchPlaylistItem[];
  };
  metadata: Record<string, unknown>;
  extractor: string;
  fallbackUsed?: string;
  /** Added by the server when the answer comes from (or was saved to) the permanent media store. */
  stored?: StoredInfo;
}

/** What we know about a stored item: its stable path, how fresh it is, and its usage statistics. */
export interface StoredInfo {
  /** Stable path for this media, e.g. `/youtube/Cwkej79U3ek`. */
  path: string;
  /** For a YouTube URL carrying both `v=` and `list=`: the path of that playlist in the video's context. */
  playlistPath?: string;
  /** The URL the media was first fetched from. */
  sourceUrl: string;
  status: 'available' | 'unavailable';
  /** True when this answer came from the store without extracting. */
  cached: boolean;
  /** The direct media URLs in this response are past their trust window and will be refreshed. */
  urlsStale: boolean;
  /** A live existence check failed without proving the media gone, so the last known answer is served. */
  validationFailed?: boolean;
  firstFetchedAt: string;
  lastFetchedAt: string;
  /** Last time the media was confirmed to still exist. */
  validatedAt: string | null;
  /** When the next existence check is due. */
  nextCheckAt: string | null;
  stats: {
    fetchCount: number;
    hitCount: number;
    viewCount: number;
    downloadCount: number;
    streamCount: number;
    prepareCount: number;
    bytesServed: number;
    lastAccessedAt: string | null;
    lastDownloadedAt: string | null;
  };
}

export interface FetchOptions {
  forceRefresh?: boolean;
  requestId: string;
}
