import { createHash } from 'node:crypto';
import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';
import mime from '../../lib/mime';
import { assertUrlIsSafeToFetch } from '../../utils/url';
import { BlazfetchResponse } from '../../types/blazfetch';
import { AdapterFetchContext, DownloadResult } from '../adapters/types';

interface CobaltMedia {
  status: 'redirect' | 'tunnel';
  url: string;
  filename: string;
}

/** Never use an unapproved public instance implicitly. Returned URLs retain SSRF checks. */
export async function fetchCobaltMedia(url: string, kind: 'video' | 'audio', signal?: AbortSignal): Promise<CobaltMedia> {
  if (!env.COBALT_API_URL) throw new BlazfetchError('EXTRACTOR_FAILED', 'Independent fallback is not configured.');
  await assertUrlIsSafeToFetch(url);
  const timeout = AbortSignal.timeout(env.FALLBACK_TIMEOUT_MS);
  let response: Response;
  try {
    // Reject redirects so credentials can never travel to another server.
    await assertUrlIsSafeToFetch(env.COBALT_API_URL);
    response = await fetch(env.COBALT_API_URL, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...(env.COBALT_API_KEY ? { authorization: `Api-Key ${env.COBALT_API_KEY}` } : {}) },
      body: JSON.stringify({ url, downloadMode: kind === 'audio' ? 'audio' : 'auto', audioFormat: 'mp3', videoQuality: 'max', youtubeVideoCodec: 'h264', youtubeVideoContainer: 'mp4', localProcessing: 'disabled' }),
    });
    const data = await response.json() as Partial<CobaltMedia>;
    if (!response.ok || !['redirect', 'tunnel'].includes(data.status ?? '') || typeof data.url !== 'string' || typeof data.filename !== 'string') {
      throw new BlazfetchError('EXTRACTOR_FAILED', 'Independent fallback returned no downloadable media.');
    }
    await assertUrlIsSafeToFetch(data.url);
    return data as CobaltMedia;
  } catch (error) {
    if (signal?.aborted) throw new BlazfetchError('DOWNLOAD_FAILED', 'Request was cancelled.');
    if (error instanceof BlazfetchError) throw error;
    // Never expose upstream errors containing endpoint credentials or signed links.
    throw new BlazfetchError('EXTRACTOR_FAILED', 'Independent fallback request failed.');
  }
}

function extension(filename: string, kind: 'video' | 'audio'): string {
  const ext = filename.split('.').at(-1)?.toLowerCase();
  const allowed = kind === 'audio' ? ['mp3', 'm4a', 'ogg', 'wav', 'opus'] : ['mp4', 'webm', 'mkv', 'mov'];
  if (!ext || !allowed.includes(ext)) throw new BlazfetchError('FORMAT_UNAVAILABLE', 'Independent fallback returned an unsupported file type.');
  return ext;
}

export async function fetchCobaltMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
  const audioOnly = ctx.normalizedUrl.platform === 'soundcloud'
    || (ctx.normalizedUrl.platform === 'newgrounds' && /^\/audio\/listen\/\d+(?:\/|$)/.test(new URL(ctx.normalizedUrl.canonicalUrl).pathname));
  const kind = audioOnly ? 'audio' : 'video';
  const result = await fetchCobaltMedia(ctx.normalizedUrl.canonicalUrl, kind);
  const ext = extension(result.filename, kind);
  const id = ctx.normalizedUrl.videoId ?? createHash('sha256').update(ctx.normalizedUrl.canonicalUrl).digest('hex').slice(0, 24);
  let audio: CobaltMedia | undefined;
  if (!audioOnly) {
    // Video recovery must not fail merely because the source has no separate audio option.
    audio = await fetchCobaltMedia(ctx.normalizedUrl.canonicalUrl, 'audio').then((media) => {
      extension(media.filename, 'audio');
      return media;
    }).catch(() => undefined);
  }
  return {
    success: true, platform: ctx.normalizedUrl.platform, mediaType: audioOnly ? 'audio' : 'video',
    mediaId: id, canonicalUrl: ctx.normalizedUrl.canonicalUrl, title: result.filename.slice(0, -(ext.length + 1)),
    formats: audioOnly ? [] : [{ formatId: 'cobalt-video', kind: 'video', ext, url: result.url, quality: 'best available' }],
    audioFormats: audioOnly ? [{ formatId: 'cobalt-audio', ext, url: result.url, isConverted: false }] : audio ? [{ formatId: 'cobalt-audio', ext: extension(audio.filename, 'audio'), url: audio.url, isConverted: false }] : [],
    metadata: {}, extractor: 'cobalt', fallbackUsed: 'cobalt',
  };
}

export async function downloadCobalt(ctx: AdapterFetchContext, kind: 'video' | 'audio', signal: AbortSignal): Promise<DownloadResult> {
  const media = await fetchCobaltMedia(ctx.normalizedUrl.canonicalUrl, kind, signal);
  const ext = extension(media.filename, kind);
  return { filePath: '', directUrl: media.url, filename: media.filename, mimeType: mime.lookup(`file.${ext}`) ?? 'application/octet-stream', bytes: 0 };
}
