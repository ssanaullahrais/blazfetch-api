import { BlazfetchAudioFormat, BlazfetchFormat } from '../../types/blazfetch';

const byHeightThenBitrate = (a: BlazfetchFormat, b: BlazfetchFormat): number =>
  (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0);

/** Below this, a phone-safe (H.264) format is not worth choosing over a sharper one that needs re-encoding. */
const MIN_HEIGHT_TO_PREFER_COMPATIBLE = 720;

/**
 * "Best" prefers an H.264 format when it reaches at least 720p: it plays on every phone and needs no re-encode,
 * whereas the sharper VP9/AV1 one (4K/1440p on YouTube) has to be transcoded, which can take minutes on a small server.
 */
export function pickBestVideoFormat(formats: BlazfetchFormat[]): BlazfetchFormat | undefined {
  const sorted = [...formats].sort(byHeightThenBitrate);
  const compatible = sorted.find((f) => f.compatible && (f.ext ?? '').toLowerCase() === 'mp4');
  if (compatible && (compatible.height ?? 0) >= MIN_HEIGHT_TO_PREFER_COMPATIBLE) return compatible;
  return sorted[0];
}

export function pickBestAudioFormat(formats: BlazfetchAudioFormat[]): BlazfetchAudioFormat | undefined {
  return [...formats].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
}
