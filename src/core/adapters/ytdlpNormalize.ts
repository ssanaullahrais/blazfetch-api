import { PlatformId } from '../../constants/platforms';
import { BlazfetchAudioFormat, BlazfetchFormat, BlazfetchResponse, MediaType } from '../../types/blazfetch';

/** Minimal shape of yt-dlp's `-J` output that we actually consume. Never exposed to the client directly. */
export interface YtdlpRawFormat {
  format_id: string;
  ext: string;
  vcodec?: string;
  acodec?: string;
  height?: number;
  width?: number;
  fps?: number;
  tbr?: number;
  abr?: number;
  filesize?: number;
  filesize_approx?: number;
  format_note?: string;
  url?: string;
  resolution?: string;
}

export interface YtdlpRawInfo {
  id: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploader_url?: string;
  channel?: string;
  channel_url?: string;
  thumbnail?: string;
  duration?: number;
  upload_date?: string;
  webpage_url?: string;
  formats?: YtdlpRawFormat[];
  ext?: string;
  is_live?: boolean;
  _type?: string;
}

function isVideoOnly(f: YtdlpRawFormat): boolean {
  return !!f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none');
}

function isAudioOnly(f: YtdlpRawFormat): boolean {
  return (!f.vcodec || f.vcodec === 'none') && !!f.acodec && f.acodec !== 'none';
}

function isCombined(f: YtdlpRawFormat): boolean {
  return !!f.vcodec && f.vcodec !== 'none' && !!f.acodec && f.acodec !== 'none';
}

/** H.264/AVC video and AAC/mp4a audio are the safest bet for universal playback; VP9, AV1, HEVC
 *  and Opus can be excellent but aren't guaranteed to play everywhere, so we flag rather than
 *  silently prefer them just because they're the highest-quality option available. */
function isCompatibleCodec(codec: string | undefined, kind: 'video' | 'audio'): boolean {
  if (!codec) return kind === 'audio';
  const normalized = codec.toLowerCase();
  if (kind === 'video') return normalized.startsWith('avc1') || normalized.startsWith('h264');
  return normalized.startsWith('mp4a') || normalized.startsWith('aac');
}

export function normalizeFormats(raw: YtdlpRawFormat[]): { formats: BlazfetchFormat[]; audioFormats: BlazfetchAudioFormat[] } {
  const formats: BlazfetchFormat[] = [];
  const audioFormats: BlazfetchAudioFormat[] = [];

  for (const f of raw) {
    if (isAudioOnly(f)) {
      audioFormats.push({
        formatId: f.format_id,
        ext: f.ext,
        bitrate: f.abr,
        codec: f.acodec,
        quality: f.format_note,
        filesizeBytes: f.filesize ?? f.filesize_approx,
        filesizeApprox: !f.filesize && !!f.filesize_approx,
        isConverted: false,
        url: f.url,
      });
      continue;
    }

    if (isCombined(f) || isVideoOnly(f)) {
      formats.push({
        formatId: f.format_id,
        ext: f.ext,
        kind: isVideoOnly(f) ? 'video_only' : 'video',
        quality: f.format_note ?? f.resolution,
        width: f.width,
        height: f.height,
        fps: f.fps,
        bitrate: f.tbr,
        codec: f.vcodec,
        filesizeBytes: f.filesize ?? f.filesize_approx,
        filesizeApprox: !f.filesize && !!f.filesize_approx,
        url: f.url,
        requiresMerge: isVideoOnly(f),
        compatible: isCompatibleCodec(f.vcodec, 'video'),
      });
    }
  }

  return { formats, audioFormats };
}

export function normalizeYtdlpInfo(
  info: YtdlpRawInfo,
  platform: PlatformId,
  canonicalUrl: string,
  extractor = 'yt-dlp',
): BlazfetchResponse {
  const { formats, audioFormats } = normalizeFormats(info.formats ?? []);
  const mediaType: MediaType = 'video';

  return {
    success: true,
    platform,
    mediaType,
    mediaId: info.id,
    canonicalUrl: info.webpage_url ?? canonicalUrl,
    title: info.title,
    description: info.description,
    author: {
      name: info.uploader ?? info.channel,
      url: info.uploader_url ?? info.channel_url,
    },
    thumbnail: info.thumbnail,
    durationSeconds: info.duration ?? null,
    uploadDate: info.upload_date,
    formats,
    audioFormats,
    metadata: { isLive: info.is_live ?? false },
    extractor,
  };
}
