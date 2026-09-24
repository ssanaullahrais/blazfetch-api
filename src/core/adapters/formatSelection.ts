import { BlazfetchAudioFormat, BlazfetchFormat } from '../../types/blazfetch';

/** Highest resolution wins; bitrate breaks ties. Codec compatibility is handled later by
 *  ensureValidAndCompatible (transcode-if-needed), so "best" here means best quality, not
 *  "best that happens to already be H.264". */
export function pickBestVideoFormat(formats: BlazfetchFormat[]): BlazfetchFormat | undefined {
  return [...formats].sort((a, b) => {
    const heightDiff = (b.height ?? 0) - (a.height ?? 0);
    if (heightDiff !== 0) return heightDiff;
    return (b.bitrate ?? 0) - (a.bitrate ?? 0);
  })[0];
}

export function pickBestAudioFormat(formats: BlazfetchAudioFormat[]): BlazfetchAudioFormat | undefined {
  return [...formats].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
}
