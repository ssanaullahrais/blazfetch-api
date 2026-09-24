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
}

export interface FetchOptions {
  forceRefresh?: boolean;
  requestId: string;
}
