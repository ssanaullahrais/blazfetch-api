import { env } from '../config/env';
import { BlazfetchAudioFormat, BlazfetchResponse } from '../types/blazfetch';

/** The bitrate the ffmpeg MP3 conversion uses (see ytdlpStream and extractAudioArgs). */
const MP3_BITRATE_KBPS = 192;

/** True when this audio option has to be converted to MP3 before it is delivered (AUDIO_FORCE_MP3). */
export function needsMp3Conversion(format: Pick<BlazfetchAudioFormat, 'ext'>): boolean {
  return env.AUDIO_FORCE_MP3 && format.ext.toLowerCase() !== 'mp3';
}

/**
 * What clients are shown when AUDIO_FORCE_MP3 is on: every audio option is an MP3 (the conversion happens when it is
 * downloaded). The format ids stay the same, so a download request still names the real source track. Sizes are
 * approximate because the MP3 is re-encoded at 192 kbps.
 */
export function presentAudioFormats<T extends BlazfetchAudioFormat>(formats: T[], mediaDurationSeconds?: number | null): T[] {
  if (!env.AUDIO_FORCE_MP3) return formats;
  return formats.map((f) => {
    if (!needsMp3Conversion(f)) return f;
    const seconds = f.durationSeconds ?? mediaDurationSeconds;
    // The MP3 is encoded at a fixed 192 kbps, so its size follows from the duration.
    const filesizeBytes = seconds && seconds > 0 ? Math.round((seconds * MP3_BITRATE_KBPS * 1000) / 8) : undefined;
    return { ...f, ext: 'mp3', codec: 'mp3', isConverted: true, filesizeApprox: true, filesizeBytes };
  });
}

export function presentMedia<T extends BlazfetchResponse>(media: T): T {
  return env.AUDIO_FORCE_MP3 ? { ...media, audioFormats: presentAudioFormats(media.audioFormats, media.durationSeconds) } : media;
}
