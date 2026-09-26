import { Readable, Transform } from 'node:stream';
import { env } from '../config/env';
import { openRanged } from '../utils/rangedFetch';
import { BlazfetchError } from '../constants/errors';
import { logger } from '../lib/logger';
import mime from '../lib/mime';
import { assertUrlIsSafeToFetch } from '../utils/url';
import { normalizeAndResolveUrl } from '../utils/shortLinks';
import { RequestedFormat } from '../core/jobs/jobTypes';
import { BlazfetchAudioFormat, BlazfetchFormat, BlazfetchResponse } from '../types/blazfetch';
import {
  FfmpegMode,
  ResolvedInput,
  StreamSource,
  resolveDirectInputs,
  spawnFfmpegRelayed,
  spawnYtdlpToStdout,
} from '../core/ytdlp/ytdlpStream';
import { fetchMedia } from './fetchService';
import { mediaKeyForResponse } from '../core/media/mediaPath';
import { resolveFormat } from './downloadService';
import { buildFilename } from '../utils/filename';
import { isManifestFormat, phoneSafeEquivalent } from '../core/adapters/formatSelection';
import { needsMp3Conversion } from '../utils/audioMp3';

export interface OpenStreamParams {
  url: string;
  formatId: string;
  kind: 'video' | 'audio';
  filename?: string;
  requestId: string;
  userId?: string | null;
  guestId?: string | null;
  signal: AbortSignal;
}

export interface OpenedStream {
  /** Remaining bytes (the first chunk has already been read and is in `firstChunk`). */
  stream: Readable;
  firstChunk: Buffer;
  contentType: string;
  filename: string;
  /** Only set when the exact size is known up front (single file piped straight through). */
  contentLength?: number;
  platform: string;
  /** Storage key of the media (item id, or `playlist:<id>`), for per-media statistics. */
  mediaKey: string;
  formatId: string;
  kill(): void;
}

/** Direct media URLs already known from the (cached) fetch: lets ffmpeg start immediately instead of
 *  waiting for yt-dlp to re-extract the page, which can take several seconds. */
type FastPath =
  | { kind: 'ffmpeg'; inputs: ResolvedInput[]; mode: FfmpegMode }
  /** A plain single file: its bytes are passed through untouched (exact size, no ffmpeg). */
  | { kind: 'proxy'; url: string };

type Plan =
  | { type: 'ytdlp'; selector: string; contentType: string; ext: string; contentLength?: number; fast?: FastPath }
  | { type: 'ffmpeg'; selector: string; mode: FfmpegMode; contentType: string; ext: string; fast?: FastPath }
  | { type: 'proxy'; url: string; contentType: string; ext: string };

const MERGE_SELECTOR = (id: string): string => `${id}+bestaudio[acodec^=mp4a]/${id}+bestaudio/best`;

function isHls(format: BlazfetchFormat): boolean {
  return isManifestFormat(format);
}

/** A playlist/manifest is not the media itself, so it can never be passed through as-is. */
function isManifestUrl(url: string): boolean {
  return isManifestFormat({ formatId: '', url });
}

function proxyFastPath(url: string | undefined): FastPath | undefined {
  return url && !isManifestUrl(url) ? { kind: 'proxy', url } : undefined;
}

/**
 * Streaming can only hand over what the source already is, and phones (WhatsApp, iOS/Android galleries) play a
 * plain MP4 with H.264 just fine, including one a live merge/remux produced (fragmented MP4 is a normal, widely
 * supported format). VP9/AV1/HEVC and WebM show a black screen or "cannot be shared" instead — those are refused
 * so `auto`/`stream` prepare a proper H.264 file.
 */
function isPhoneSafeVideo(format: BlazfetchFormat): boolean {
  const codec = (format.codec ?? '').toLowerCase();
  const codecOk = !codec || codec === 'unknown' || codec.startsWith('avc') || codec.startsWith('h264');
  return format.ext.toLowerCase() === 'mp4' && codecOk;
}

/** AAC/mp4a plays inside the M4A a live HLS-audio remux produces; anything else (Opus, etc.) needs a real prepare. */
function isPhoneSafeAudioCodec(codec?: string): boolean {
  const c = (codec ?? '').toLowerCase();
  return c.startsWith('mp4a') || c.startsWith('aac');
}

/** sizeBytes, when known, lets the controller pick a quicker (larger-output) ffmpeg preset for a big prepare. */
function notPhoneSafe(sizeBytes?: number): BlazfetchError {
  return new BlazfetchError(
    'DOWNLOAD_FAILED',
    'This format would not play on phones when streamed as-is. Use mode=auto or mode=prepare for a compatible MP4.',
    { streamUnsupported: true, filesizeBytes: sizeBytes },
  );
}

/** AAC audio merges into MP4 without re-encoding; otherwise the highest-bitrate track wins. */
function bestAudioWithUrl(media: BlazfetchResponse): BlazfetchAudioFormat | undefined {
  const withUrl = media.audioFormats.filter((a) => a.url && !a.isConverted);
  const byBitrate = (a: BlazfetchAudioFormat, b: BlazfetchAudioFormat): number => (b.bitrate ?? 0) - (a.bitrate ?? 0);
  return withUrl.filter((a) => a.codec?.startsWith('mp4a')).sort(byBitrate)[0] ?? withUrl.sort(byBitrate)[0];
}

function fastPathFor(media: BlazfetchResponse, chosen: BlazfetchFormat, mode: 'merge' | 'remux'): FastPath | undefined {
  if (!chosen.url) return undefined;
  const video: ResolvedInput = { url: chosen.url, headers: {} };
  if (mode === 'remux') return { kind: 'ffmpeg', inputs: [video], mode };
  const audio = bestAudioWithUrl(media);
  return audio?.url ? { kind: 'ffmpeg', inputs: [video, { url: audio.url, headers: {} }], mode } : undefined;
}

function contentTypeFor(ext: string, kind: 'video' | 'audio'): string {
  return mime.lookup(`x.${ext}`) ?? (kind === 'audio' ? 'audio/mpeg' : 'video/mp4');
}

/**
 * When the top pick is VP9/AV1 (or needs a merge) and the source has no H.264 twin at that height, a plain
 * single-file MP4 with sound (Instagram's and Facebook's progressive files) still plays everywhere and streams
 * instantly with an exact size. Undefined when the pick is already fine or no such file exists.
 */
function progressiveH264Fallback(formats: BlazfetchFormat[], chosen: BlazfetchFormat): BlazfetchFormat | undefined {
  if (!chosen.requiresMerge && isPhoneSafeVideo(chosen)) return undefined;
  const candidates = formats.filter(
    (f) => f.kind === 'video' && !f.requiresMerge && !!f.url && !isManifestFormat(f) && isPhoneSafeVideo(f) && f.formatId !== chosen.formatId,
  );
  if (candidates.length === 0) return undefined;
  const score = (f: BlazfetchFormat): number => (f.height ?? 0) * 1e9 + (f.bitrate ?? 0) * 1e3 + (f.filesizeBytes ?? 0) / 1e6;
  // Extractors list qualities worst to best, so on a tie the later entry wins.
  return candidates.reduce((best, f) => (score(f) >= score(best) ? f : best));
}

/** Picks how to produce the bytes. Nothing here touches disk or transcodes video. Refuses a codec that would not
 * play on phones as-is (VP9/AV1/HEVC), whether the source is a merge, an HLS manifest, or a single file; the
 * caller prepares a compatible file instead — see streamController's UNSAFE_LARGE_VIDEO_STREAM_ENABLED for the
 * one deliberate, opt-in exception to that, applied after the fact. */
export function planStream(media: BlazfetchResponse, format: RequestedFormat): Plan {
  const isYtdlp = !media.extractor || media.extractor.startsWith('yt-dlp');
  const requirePhoneSafe = (f: BlazfetchFormat): void => {
    if (!isPhoneSafeVideo(f)) throw notPhoneSafe(f.filesizeBytes);
  };

  if (format.kind === 'video') {
    const chosen = media.formats.find((f) => f.formatId === format.formatId);
    if (!chosen) {
      // A video inside a carousel/board has its own direct link: pass that through (mixed photo+video posts).
      const fromItem = media.items?.flatMap((i) => i.formats ?? []).find((f) => f.formatId === format.formatId);
      if (fromItem?.url) {
        requirePhoneSafe(fromItem);
        return { type: 'proxy', url: fromItem.url, contentType: contentTypeFor(fromItem.ext, 'video'), ext: fromItem.ext };
      }
      throw new BlazfetchError('FORMAT_UNAVAILABLE', 'The requested format is not available for this media.');
    }

    if (!isYtdlp) {
      if (!chosen.url) throw new BlazfetchError('FORMAT_UNAVAILABLE', 'This media can only be downloaded with POST /api/v1/download.', { streamUnsupported: true });
      requirePhoneSafe(chosen);
      return { type: 'proxy', url: chosen.url, contentType: contentTypeFor(chosen.ext, 'video'), ext: chosen.ext };
    }
    // A live merge/remux (including from an HLS manifest — YouTube serves plenty of its H.264 formats that way) of
    // a non-H.264 source (VP9/AV1/HEVC) comes out as that codec inside an MP4 wrapper, which phones cannot play at
    // all: auto prepares a real H.264 file instead. An H.264 source still streams live either way.
    if ((chosen.requiresMerge || isHls(chosen)) && !isPhoneSafeVideo(chosen)) throw notPhoneSafe(chosen.filesizeBytes);
    if (chosen.requiresMerge) {
      return { type: 'ffmpeg', selector: MERGE_SELECTOR(chosen.formatId), mode: 'merge', contentType: 'video/mp4', ext: 'mp4', fast: fastPathFor(media, chosen, 'merge') };
    }
    if (isHls(chosen)) {
      return { type: 'ffmpeg', selector: chosen.formatId, mode: 'remux', contentType: 'video/mp4', ext: 'mp4', fast: fastPathFor(media, chosen, 'remux') };
    }
    requirePhoneSafe(chosen);
    return {
      type: 'ytdlp',
      fast: proxyFastPath(chosen.url),
      selector: chosen.formatId,
      contentType: contentTypeFor(chosen.ext, 'video'),
      ext: chosen.ext,
      contentLength: chosen.filesizeBytes && !chosen.filesizeApprox ? chosen.filesizeBytes : undefined,
    };
  }

  // Audio: a real standalone audio track is piped as-is; anything else becomes MP3 through ffmpeg.
  const audio: BlazfetchAudioFormat | undefined = media.audioFormats.find((f) => f.formatId === format.formatId);
  if (audio && !audio.isConverted && needsMp3Conversion(audio)) {
    // AUDIO_FORCE_MP3: any track that is not already MP3 is converted live through ffmpeg (no temp file).
    return {
      type: 'ffmpeg',
      selector: audio.formatId,
      mode: 'mp3',
      contentType: 'audio/mpeg',
      ext: 'mp3',
      fast: audio.url ? { kind: 'ffmpeg', inputs: [{ url: audio.url, headers: {} }], mode: 'mp3' } : undefined,
    };
  }
  if (audio && !audio.isConverted) {
    // An HLS audio track would come out of yt-dlp as MPEG-TS. A live remux to AAC-in-M4A plays fine; anything else
    // (Opus, etc.) is prepared into a normal M4A instead.
    if (isYtdlp && isHls({ formatId: audio.formatId, url: audio.url } as BlazfetchFormat)) {
      if (!isPhoneSafeAudioCodec(audio.codec)) throw notPhoneSafe(audio.filesizeBytes);
      return {
        type: 'ffmpeg',
        selector: audio.formatId,
        mode: 'audio',
        contentType: 'audio/mp4',
        ext: 'm4a',
        fast: audio.url ? { kind: 'ffmpeg', inputs: [{ url: audio.url, headers: {} }], mode: 'audio' } : undefined,
      };
    }
    if (!isYtdlp) {
      if (!audio.url) throw new BlazfetchError('FORMAT_UNAVAILABLE', 'This media can only be downloaded with POST /api/v1/download.', { streamUnsupported: true });
      return { type: 'proxy', url: audio.url, contentType: contentTypeFor(audio.ext, 'audio'), ext: audio.ext };
    }
    return {
      type: 'ytdlp',
      // Pass the audio file through untouched from the cached URL (no yt-dlp re-extraction).
      fast: proxyFastPath(audio.url),
      selector: audio.formatId,
      contentType: contentTypeFor(audio.ext, 'audio'),
      ext: audio.ext,
      contentLength: audio.filesizeBytes && !audio.filesizeApprox ? audio.filesizeBytes : undefined,
    };
  }

  const sourceId = format.formatId.startsWith('mp3-from-') ? format.formatId.slice('mp3-from-'.length) : format.formatId;
  const source = media.formats.find((f) => f.formatId === sourceId) ?? media.formats[0];
  if (!source || !isYtdlp) {
    throw new BlazfetchError('FORMAT_UNAVAILABLE', 'MP3 conversion is not available in stream mode for this media. Use POST /api/v1/download.', { streamUnsupported: true });
  }
  const audioSource = bestAudioWithUrl(media);
  const mp3Url = source.requiresMerge ? audioSource?.url : (source.url ?? audioSource?.url);
  return {
    type: 'ffmpeg',
    selector: source.requiresMerge ? `bestaudio/${source.formatId}` : source.formatId,
    mode: 'mp3',
    contentType: 'audio/mpeg',
    ext: 'mp3',
    fast: mp3Url ? { kind: 'ffmpeg', inputs: [{ url: mp3Url, headers: {} }], mode: 'mp3' } : undefined,
  };
}

/** Counts bytes and aborts once the configured maximum is exceeded. */
function limitBytes(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new BlazfetchError('FILE_TOO_LARGE', 'The file exceeds the maximum allowed download size.'));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Reads the first chunk so the caller can still answer with a JSON error if nothing ever arrives. */
export function waitForFirstChunk(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const onData = (chunk: Buffer): void => {
      stream.pause();
      cleanup();
      resolve(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new BlazfetchError('EXTRACTOR_FAILED', 'The source produced no data.'));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

export { buildFilename } from '../utils/filename';

/**
 * Streams a plain HTTP(S) file through untouched, in ranged chunks (see openRanged) so hosts that throttle one long
 * request (YouTube does, to about playback speed) still deliver at full speed. A source that ends early errors
 * instead of finishing quietly.
 */
export async function openProxy(url: string, signal: AbortSignal, requestId: string): Promise<StreamSource> {
  await assertUrlIsSafeToFetch(url);
  let source: Awaited<ReturnType<typeof openRanged>>;
  try {
    source = await openRanged(url, { signal });
  } catch (err) {
    logger.warn({ requestId, err: (err as Error).message }, 'stream proxy upstream failed');
    throw err instanceof BlazfetchError ? err : new BlazfetchError('DOWNLOAD_FAILED', 'Failed to fetch media from the source.');
  }
  const { stream, totalBytes } = source;
  return { stream, kill: () => stream.destroy(), contentLength: totalBytes };
}

/**
 * Media URLs come out of the extractor, i.e. from the source page, so they are checked like any user-supplied link
 * before yt-dlp or ffmpeg is allowed to fetch them (neither applies the SSRF rules itself).
 */
async function assertInputsAreSafe(inputs: ResolvedInput[]): Promise<void> {
  for (const input of inputs) await assertUrlIsSafeToFetch(input.url);
}

async function openSource(plan: Plan, url: string, signal: AbortSignal, requestId: string): Promise<StreamSource> {
  if (plan.type === 'ytdlp') {
    // yt-dlp re-extracts and downloads the same format: check where that format's bytes live first.
    if (plan.fast?.kind === 'proxy') await assertUrlIsSafeToFetch(plan.fast.url);
    return spawnYtdlpToStdout({ url, formatSelector: plan.selector, signal });
  }

  if (plan.type === 'ffmpeg') {
    const inputs: ResolvedInput[] = await resolveDirectInputs({ url, formatSelector: plan.selector, signal });
    await assertInputsAreSafe(inputs);
    return spawnFfmpegRelayed({ inputs, mode: plan.mode, signal });
  }

  return openProxy(plan.url, signal, requestId);
}

/** Vimeo watch pages sometimes need the public player URL instead (same fallback the prepare mode uses). */
function sourceUrlCandidates(canonicalUrl: string, platform: string): string[] {
  if (platform === 'vimeo') {
    const match = canonicalUrl.match(/vimeo\.com\/(\d+)/);
    if (match) return [canonicalUrl, `https://player.vimeo.com/video/${match[1]}`];
  }
  return [canonicalUrl];
}

/**
 * Validates the request, decides how to stream it, starts the processes, and resolves once the
 * FIRST byte has arrived. Anything that fails before that point rejects with a BlazfetchError, so
 * the controller can still reply with the normal JSON error envelope.
 */
export async function openStream(params: OpenStreamParams, retriedWithFreshLinks = false): Promise<OpenedStream> {
  const normalized = await normalizeAndResolveUrl(params.url);
  await assertUrlIsSafeToFetch(normalized.canonicalUrl);

  let resolved = await resolveFormat(params.url, params.requestId, { formatId: params.formatId, kind: params.kind });
  // requireFreshUrls: the fast path below feeds the stored direct URLs to ffmpeg, so they must not be stale.
  const media = await fetchMedia({
    url: params.url,
    requestId: params.requestId,
    internal: true,
    userId: params.userId,
    guestId: params.guestId,
    requireFreshUrls: true,
    forceRefresh: retriedWithFreshLinks,
  });
  // Same quality in H.264 when the source offers it, so the streamed file plays on phones (not VP9/AV1).
  if (resolved.kind === 'video') {
    const chosen = media.formats.find((f) => f.formatId === resolved.formatId);
    const equivalent = chosen ? phoneSafeEquivalent(media.formats, chosen) : undefined;
    const fallback = chosen && !equivalent && params.formatId.toLowerCase() === 'best' ? progressiveH264Fallback(media.formats, chosen) : undefined;
    const better = equivalent ?? fallback;
    if (better) resolved = { ...resolved, formatId: better.formatId };
  }
  const plan = planStream(media, resolved);

  const candidates = sourceUrlCandidates(normalized.canonicalUrl, normalized.platform);
  let lastError: unknown;

  for (const candidate of candidates) {
    if (candidate !== normalized.canonicalUrl) await assertUrlIsSafeToFetch(candidate);

    // Try the instant path first (ffmpeg on the URLs from the cached fetch), then the full path.
    const openers: { fast: boolean; open: () => Promise<StreamSource> }[] = [];
    if (plan.type !== 'proxy' && plan.fast) {
      const fast = plan.fast;
      openers.push({
        fast: true,
        open: async () =>
          fast.kind === 'proxy'
            ? openProxy(fast.url, params.signal, params.requestId)
            : assertInputsAreSafe(fast.inputs).then(() => spawnFfmpegRelayed({ inputs: fast.inputs, mode: fast.mode, signal: params.signal })),
      });
    }
    openers.push({ fast: false, open: () => openSource(plan, candidate, params.signal, params.requestId) });

    for (const opener of openers) {
      let source: StreamSource | undefined;
      try {
        source = await opener.open();
        const limited = source.stream.pipe(limitBytes(env.MAX_DOWNLOAD_SIZE_BYTES));
        source.stream.on('error', (err) => limited.destroy(err));
        const firstChunk = await waitForFirstChunk(limited);
        return {
          stream: limited,
          firstChunk,
          contentType: plan.contentType,
          filename: buildFilename(params.filename, media, plan.ext),
          // The exact size is only known when the file is passed through untouched.
          contentLength: source.contentLength ?? (plan.type === 'ytdlp' && !opener.fast ? plan.contentLength : undefined),
          platform: normalized.platform,
          mediaKey: mediaKeyForResponse(media),
          formatId: resolved.formatId,
          kill: source.kill,
        };
      } catch (err) {
        source?.kill();
        lastError = err;
        if (params.signal.aborted) throw err;
        logger.warn(
          { requestId: params.requestId, err: (err as Error).message, source: candidate, fastPath: opener.fast },
          'stream source failed before first byte',
        );
      }
    }
  }

  // A direct link (from a fallback provider) that was refused has most likely expired: get a fresh one once.
  if (!retriedWithFreshLinks && !params.signal.aborted && lastError instanceof BlazfetchError && lastError.code === 'DOWNLOAD_FAILED' && plan.type === 'proxy') {
    logger.warn({ requestId: params.requestId }, 'direct link was refused, retrying with a freshly extracted one');
    return openStream(params, true);
  }

  if (lastError instanceof BlazfetchError && lastError.code === 'DOWNLOAD_FAILED' && plan.type === 'ffmpeg') {
    throw new BlazfetchError('DOWNLOAD_FAILED', 'This source could not be streamed directly. Use mode=auto or mode=prepare (or POST /api/v1/download) for it instead.', { streamUnsupported: true });
  }
  throw lastError instanceof BlazfetchError ? lastError : new BlazfetchError('DOWNLOAD_FAILED', 'Failed to start the stream.');
}
