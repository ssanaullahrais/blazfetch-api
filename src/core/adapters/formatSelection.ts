import { BlazfetchAudioFormat, BlazfetchFormat } from '../../types/blazfetch';

/**
 * A playlist (HLS/DASH manifest) rather than the file itself. YouTube lists an HLS copy next to the plain file at
 * most qualities (`manifest.googlevideo.com/.../hls_playlist/...`, no size): it downloads in fragments and is slower.
 */
export function isManifestFormat(format: Pick<BlazfetchFormat, 'formatId' | 'url'>): boolean {
  const url = format.url ?? '';
  return /\.(m3u8|mpd)(\?|$)/i.test(url) || /\/(hls_playlist|dash_manifest|manifest\/dash)\//i.test(url) || /^hls/i.test(format.formatId);
}

/** H.264 in MP4: plays on every phone as-is. */
export function isPhoneSafeFormat(format: BlazfetchFormat): boolean {
  return !!format.compatible && (format.ext ?? '').toLowerCase() === 'mp4';
}

/** Highest first; at the same height the plain file beats a manifest copy, then the higher bitrate wins. */
const byHeightThenBitrate = (a: BlazfetchFormat, b: BlazfetchFormat): number =>
  (b.height ?? 0) - (a.height ?? 0) || Number(isManifestFormat(a)) - Number(isManifestFormat(b)) || (b.bitrate ?? 0) - (a.bitrate ?? 0);

/** Below this, a phone-safe (H.264) format is not worth choosing over a sharper one that needs re-encoding. */
const MIN_HEIGHT_TO_PREFER_COMPATIBLE = 720;

/**
 * "Best" prefers an H.264 format when it reaches at least 720p: it plays on every phone and needs no re-encode,
 * whereas the sharper VP9/AV1 one (4K/1440p on YouTube) has to be transcoded, which can take minutes on a small server.
 */
export function pickBestVideoFormat(formats: BlazfetchFormat[]): BlazfetchFormat | undefined {
  const sorted = [...formats].sort(byHeightThenBitrate);
  const compatible = sorted.find(isPhoneSafeFormat);
  if (compatible && (compatible.height ?? 0) >= MIN_HEIGHT_TO_PREFER_COMPATIBLE) return compatible;
  return sorted[0];
}

/** AAC (M4A) or MP3: plays in every phone's music and files apps, unlike Opus/Vorbis in WebM. */
function isPhoneSafeAudio(format: BlazfetchAudioFormat): boolean {
  const ext = format.ext.toLowerCase();
  const codec = (format.codec ?? '').toLowerCase();
  return ext === 'mp3' || ext === 'm4a' || codec.startsWith('mp4a') || codec.startsWith('aac') || codec === 'mp3';
}

/** A phone-safe track this close to the top bitrate sounds the same, so it wins (YouTube: AAC 129k vs Opus 135k). */
const PHONE_SAFE_AUDIO_SHARE = 0.8;

export function pickBestAudioFormat(formats: BlazfetchAudioFormat[]): BlazfetchAudioFormat | undefined {
  const sorted = [...formats].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const top = sorted[0];
  const phoneSafe = sorted.find(isPhoneSafeAudio);
  if (top && phoneSafe && (phoneSafe.bitrate ?? 0) >= (top.bitrate ?? 0) * PHONE_SAFE_AUDIO_SHARE) return phoneSafe;
  return top;
}

/**
 * For a job that must end as H.264/AAC MP4: the same quality in H.264, when the source offers one, so a VP9/AV1/WebM
 * pick is downloaded ready to play instead of being re-encoded (which takes minutes for a long video). Same height,
 * at least the same frame rate, plain file preferred. Undefined when the pick is already H.264 or has no equivalent.
 */
export function phoneSafeEquivalent(formats: BlazfetchFormat[], chosen: BlazfetchFormat): BlazfetchFormat | undefined {
  if (isPhoneSafeFormat(chosen) || !chosen.height) return undefined;
  return formats
    .filter((f) => f.height === chosen.height && isPhoneSafeFormat(f) && (f.fps ?? 0) >= (chosen.fps ?? 0) - 1)
    .sort(byHeightThenBitrate)[0];
}
