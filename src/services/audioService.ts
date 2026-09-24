import { fetchMedia, FetchMediaParams } from './fetchService';
import { BlazfetchAudioFormat, BlazfetchResponse } from '../types/blazfetch';

/** POST /api/v1/fetch/audio response: same metadata, but scoped to audio options only. */
export interface AudioFetchResponse {
  success: true;
  platform: BlazfetchResponse['platform'];
  mediaId: string;
  canonicalUrl: string;
  title?: string;
  durationSeconds?: number | null;
  audioFormats: BlazfetchAudioFormat[];
  requiresConversion: boolean;
}

export async function fetchAudio(params: FetchMediaParams): Promise<AudioFetchResponse> {
  const media = await fetchMedia(params);

  const audioFormats = [...media.audioFormats];
  const requiresConversion = audioFormats.length === 0 && media.formats.length > 0;

  if (requiresConversion) {
    const bestVideo = media.formats.find((f) => f.kind === 'video') ?? media.formats[0];
    audioFormats.push({
      formatId: `mp3-from-${bestVideo.formatId}`,
      ext: 'mp3',
      bitrate: 192,
      quality: 'standard (converted via ffmpeg)',
      durationSeconds: media.durationSeconds ?? undefined,
      isConverted: true,
    });
  }

  return {
    success: true,
    platform: media.platform,
    mediaId: media.mediaId,
    canonicalUrl: media.canonicalUrl,
    title: media.title,
    durationSeconds: media.durationSeconds,
    audioFormats,
    requiresConversion,
  };
}
