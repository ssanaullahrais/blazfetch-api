import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { assertUrlIsSafeToFetch, validateAndNormalizeUrl } from '../utils/url';
import { normalizeAndResolveUrl } from '../utils/shortLinks';
import { getAdapter } from '../core/adapters/registry';
import { DownloadResult } from '../core/adapters/types';
import { globalDownloadSemaphore, acquireVisitorDownloadSlots, conversionSemaphore, conversionThreads } from '../core/jobs/concurrencyLimiter';
import { createJob, getJob, getJobSignal, updateJobProgress, updateJobStatus, clearJobController } from '../core/jobs/jobManager';
import { jobTempDir, cleanupJobTempDir } from '../core/jobs/tempFiles';
import { runFfmpeg, extractAudioArgs, transcodeToCompatibleMp4Args } from '../core/ffmpeg/ffmpegRunner';
import { isBrowserCompatibleMp4, validateMediaFile } from '../core/ffmpeg/ffprobe';
import { phoneSafeEquivalent, pickBestAudioFormat, pickBestVideoFormat } from '../core/adapters/formatSelection';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { recordDownloadStat } from './statsService';
import { fetchMedia } from './fetchService';
import { mediaKeyForResponse } from '../core/media/mediaPath';
import { fetchAudio } from './audioService';
import { JobRecord, RequestedFormat } from '../core/jobs/jobTypes';
import { BlazfetchError } from '../constants/errors';
import { needsMp3Conversion } from '../utils/audioMp3';
import { buildFilename } from '../utils/filename';
import { openRanged } from '../utils/rangedFetch';
import type { BlazfetchResponse } from '../types/blazfetch';

export interface StartDownloadParams {
  url: string;
  format: RequestedFormat;
  requestId: string;
  userId?: string | null;
  guestId?: string | null;
}

const BEST_SENTINEL = 'best';

/** `formatId: "best"` (or omitted) resolves to the highest-quality option automatically —
 *  highest resolution for video, highest bitrate for audio/MP3 — so callers don't need to
 *  enumerate formats first just to get the default top-quality download. */
export async function resolveFormat(url: string, requestId: string, format: RequestedFormat): Promise<RequestedFormat> {
  if (format.formatId && format.formatId.toLowerCase() !== BEST_SENTINEL) {
    return format;
  }

  if (format.kind === 'video') {
    const media = await fetchMedia({ url, requestId, internal: true });
    const best = pickBestVideoFormat(media.formats);
    if (!best) throw new BlazfetchError('FORMAT_UNAVAILABLE', 'No video formats are available for this media.');
    return { ...format, formatId: best.formatId, quality: best.quality };
  }

  const audio = await fetchAudio({ url, requestId, internal: true });
  const best = pickBestAudioFormat(audio.audioFormats);
  if (!best) throw new BlazfetchError('FORMAT_UNAVAILABLE', 'No audio formats are available for this media.');
  return { ...format, formatId: best.formatId, quality: best.quality };
}

export async function startDownloadJob(params: StartDownloadParams): Promise<JobRecord> {
  const normalizedUrl = await normalizeAndResolveUrl(params.url);
  const resolvedFormat = await resolveFormat(params.url, params.requestId, params.format);
  const job = await createJob({
    platform: normalizedUrl.platform,
    mediaId: null,
    canonicalUrl: normalizedUrl.canonicalUrl,
    requestedFormat: resolvedFormat,
    userId: params.userId,
    guestId: params.guestId,
  });
  return job;
}

export interface RunDownloadResult extends DownloadResult {
  job: JobRecord;
}

/**
 * Runs the actual download for a previously created job: resolves the source, streams progress
 * into the job row, and — only when the requested format genuinely needs it (video-only+audio
 * merge, or MP3 extraction from a video-only source) — uses a temp file via ffmpeg. Otherwise
 * the adapter's result (a direct CDN URL or a yt-dlp-produced file) is returned as-is so the
 * controller can stream it straight to the client.
 */
export interface RunDownloadOptions {
  /** GET /stream?mode=auto fell back to preparing the file after direct streaming failed. */
  fellBack?: boolean;
  /** GET /stream records the entire response outcome itself, including preparation failures. */
  recordFailure?: boolean;
  /** The requester's network (see networkKey), for the per-IP download limit on guests. */
  networkKey?: string;
  /** Name for the saved file, without extension (the page's own naming); the title is used otherwise. */
  filename?: string;
  /** Convert with ffmpeg's quickest settings (Fastest): a larger file, much sooner. */
  fastConvert?: boolean;
}

/**
 * How the job's 0–100 progress is shared out: the download itself, then converting to H.264/AAC (or MP3) when the
 * source needs it. A job that needs no conversion jumps from DOWNLOAD_SHARE to 100 when it is done.
 */
const DOWNLOAD_SHARE = 90;
const AUDIO_DOWNLOAD_SHARE = 50;
/** Prefix of the MP3 options made from a video format (see audioService). */
const MP3_FROM_PREFIX = 'mp3-from-';

/**
 * Converting takes far longer than a remux, so it gets at least the whole download budget rather than ffmpeg's short
 * one, and more for a long video (a small server can encode slower than real time).
 */
function convertTimeoutMs(durationSeconds: number | undefined): number {
  return Math.max(env.FFMPEG_TIMEOUT_MS, env.DOWNLOAD_TOTAL_TIMEOUT_MS, (durationSeconds ?? 0) * 2000);
}

/**
 * Prepared downloads are written to TEMP_DIR first: refuse a new one while the disk is nearly full (MIN_FREE_DISK_MB)
 * instead of letting it fill up and break everything else on the server.
 */
async function assertDiskSpace(): Promise<void> {
  if (!env.MIN_FREE_DISK_MB) return;
  try {
    await fs.promises.mkdir(env.TEMP_DIR, { recursive: true });
    const stats = await fs.promises.statfs(env.TEMP_DIR);
    const freeMb = (stats.bavail * stats.bsize) / (1024 * 1024);
    if (freeMb < env.MIN_FREE_DISK_MB) {
      logger.warn({ freeMb: Math.round(freeMb), minFreeMb: env.MIN_FREE_DISK_MB }, 'refusing a prepared download: low disk space');
      throw new BlazfetchError('SERVER_BUSY', 'The server is busy right now. Please try again in a few minutes.');
    }
  } catch (err) {
    if (err instanceof BlazfetchError) throw err;
    // statfs unsupported here: carry on rather than refuse every download.
  }
}

/** Progress writes are best effort: one that fails must never turn into an unhandled rejection. */
function reportProgress(jobId: string, downloadedBytes: number, totalBytes: number | undefined, percent: number | undefined): void {
  updateJobProgress(jobId, downloadedBytes, totalBytes, percent).catch((err) => {
    logger.debug({ jobId, err: (err as Error).message }, 'could not store job progress');
  });
}

/** A size, or an estimate from the bitrate (kbit/s) and duration, which is all HLS formats come with. */
function sizeOf(format: { filesizeBytes?: number; bitrate?: number } | undefined, durationSeconds: number | null | undefined): number | undefined {
  if (format?.filesizeBytes) return format.filesizeBytes;
  return format?.bitrate && durationSeconds ? Math.round((format.bitrate * 1000 * durationSeconds) / 8) : undefined;
}

/** Size of the finished video file, to show progress when the downloader reports none. */
function expectedVideoBytes(metadata: BlazfetchResponse, formatId: string, merging: boolean): number | undefined {
  const video = sizeOf(metadata.formats.find((f) => f.formatId === formatId), metadata.durationSeconds);
  if (!video || !merging) return video;
  const audio = [...metadata.audioFormats]
    .filter((a) => !a.isConverted)
    .sort((a, b) => Number(!!b.codec?.startsWith('mp4a')) - Number(!!a.codec?.startsWith('mp4a')) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
  return video + (sizeOf(audio, metadata.durationSeconds) ?? 0);
}

/** Saves a direct link to disk (in ranged chunks, SSRF-checked), reporting 0–100 as it goes. */
async function downloadToFile(url: string, filePath: string, signal: AbortSignal, onPercent: (percent: number) => void): Promise<void> {
  await assertUrlIsSafeToFetch(url);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const source = await openRanged(url, { signal });
  let received = 0;
  source.stream.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > env.MAX_DOWNLOAD_SIZE_BYTES) source.stream.destroy(new BlazfetchError('FILE_TOO_LARGE', 'The file exceeds the maximum allowed download size.'));
    else if (source.totalBytes) onPercent((received / source.totalBytes) * 100);
  });
  await pipeline(source.stream, fs.createWriteStream(filePath), { signal });
}

/** "<title>.<ext>" for the saved file, instead of the id-based name yt-dlp wrote to disk. */
function displayName(result: DownloadResult, metadata: BlazfetchResponse | undefined, requested: string | undefined, kind: 'video' | 'audio'): string {
  if (!metadata) return result.filename;
  const ext = (result.filename.split('.').pop() ?? 'mp4').toLowerCase();
  // An audio-only MP4 is an M4A file: name it so, or phones file it under videos.
  if (kind === 'audio' && ext === 'mp4') return buildFilename(requested, metadata, 'm4a');
  return buildFilename(requested, metadata, ext);
}

export async function runDownloadJob(job: JobRecord, requestId: string, options: RunDownloadOptions = {}): Promise<RunDownloadResult> {
  const normalizedUrl = await normalizeAndResolveUrl(job.canonicalUrl);
  const adapter = getAdapter(normalizedUrl);
  const signal = getJobSignal(job.id);

  // Refused before any work starts (too many downloads for this visitor, low disk): the job must still end as
  // failed with the reason, or a client polling GET /jobs/:id would wait on "queued" forever.
  let releaseUserSlot: () => void;
  try {
    await assertDiskSpace();
    releaseUserSlot = acquireVisitorDownloadSlots({ userId: job.userId, guestId: job.guestId, networkKey: options.networkKey, kind: job.requestedFormat.kind });
  } catch (err) {
    await finalizeFailure(job, err, Date.now(), false, { fellBack: options.fellBack, recordFailure: options.recordFailure });
    clearJobController(job.id);
    throw err;
  }
  const releaseGlobalSlot = await globalDownloadSemaphore.acquire();

  const startedAt = Date.now();
  const ctx: StatContext = { fellBack: options.fellBack, recordFailure: options.recordFailure };
  await updateJobStatus(job.id, 'preparing');

  try {
    const outputDir = jobTempDir(job.id);
    let effectiveFormatId = job.requestedFormat.formatId;
    let metadata: BlazfetchResponse | undefined;
    let expectedBytes: number | undefined;

    if (job.requestedFormat.kind === 'audio') {
      metadata = await fetchMedia({ url: job.canonicalUrl, requestId, internal: true });
      ctx.mediaKey = mediaKeyForResponse(metadata);
      const standaloneAudio = metadata.audioFormats.find((f) => f.formatId === job.requestedFormat.formatId);
      // The media URL comes from the source page and yt-dlp fetches it without the SSRF checks.
      if (standaloneAudio?.url) await assertUrlIsSafeToFetch(standaloneAudio.url);
      if (!standaloneAudio || needsMp3Conversion(standaloneAudio)) {
        return await runAudioExtraction(job, adapter, normalizedUrl, outputDir, signal, requestId, startedAt, { ...ctx, metadata, filename: options.filename });
      }
      expectedBytes = sizeOf(standaloneAudio, metadata.durationSeconds);
    } else {
      metadata = await fetchMedia({ url: job.canonicalUrl, requestId, internal: true });
      ctx.mediaKey = mediaKeyForResponse(metadata);
      const requested = metadata.formats.find((f) => f.formatId === job.requestedFormat.formatId);
      // The result has to be H.264/AAC: take the same quality in H.264 when there is one instead of re-encoding.
      const equivalent = requested ? phoneSafeEquivalent(metadata.formats, requested) : undefined;
      if (equivalent) logger.info({ jobId: job.id, requested: requested?.formatId, using: equivalent.formatId }, 'using the H.264 version of the requested quality');
      const format = equivalent ?? requested;
      if (format) effectiveFormatId = format.formatId;
      if (format?.url) await assertUrlIsSafeToFetch(format.url);
      expectedBytes = format ? expectedVideoBytes(metadata, format.formatId, !!format.requiresMerge) : undefined;
      if (format?.requiresMerge) {
        // Prefer an AAC/mp4a audio track so the merged output is H.264+AAC MP4 without needing
        // to transcode; yt-dlp falls through to the best available audio if none matches.
        effectiveFormatId = `${format.formatId}+bestaudio[acodec^=mp4a]/${format.formatId}+bestaudio/best`;
      }
    }

    await updateJobStatus(job.id, 'streaming');
    let result = await adapter.download(
      { requestId, normalizedUrl },
      {
        formatId: effectiveFormatId,
        kind: job.requestedFormat.kind,
        outputDir,
        signal,
        expectedBytes,
        onProgress: (progress) => {
          const share = job.requestedFormat.kind === 'video' ? DOWNLOAD_SHARE : 99;
          reportProgress(job.id, progress.downloadedBytes, progress.totalBytes, progress.percent === undefined ? undefined : (progress.percent * share) / 100);
        },
      },
    );

    result = await ensureValidAndCompatible(job, result, signal, options.fastConvert);
    result = { ...result, filename: displayName(result, metadata, options.filename, job.requestedFormat.kind) };
    await finalizeSuccess(job, result, startedAt, ctx);
    return { ...result, job: await refreshJob(job.id) };
  } catch (err) {
    await finalizeFailure(job, err, startedAt, signal.aborted, ctx);
    throw err;
  } finally {
    releaseUserSlot();
    releaseGlobalSlot();
    clearJobController(job.id);
  }
}

async function runAudioExtraction(
  job: JobRecord,
  adapter: ReturnType<typeof getAdapter>,
  normalizedUrl: ReturnType<typeof validateAndNormalizeUrl>,
  outputDir: string,
  signal: AbortSignal,
  requestId: string,
  startedAt: number,
  ctx: StatContext & { metadata?: BlazfetchResponse; filename?: string },
): Promise<RunDownloadResult> {
  await updateJobStatus(job.id, 'streaming');

  // "mp3-from-<id>" is the MP3 made from video format <id>: yt-dlp only knows <id>.
  const requested = job.requestedFormat.formatId;
  const sourceFormatId = requested.startsWith(MP3_FROM_PREFIX) ? requested.slice(MP3_FROM_PREFIX.length) : requested;
  const videoResult = await adapter.download(
    { requestId, normalizedUrl },
    {
      formatId: sourceFormatId,
      kind: 'video',
      outputDir,
      signal,
      onProgress: (progress) => {
        reportProgress(job.id, progress.downloadedBytes, progress.totalBytes, progress.percent === undefined ? undefined : (progress.percent * AUDIO_DOWNLOAD_SHARE) / 100);
      },
    },
  );

  // Fallback providers only hand out a direct link: fetch it to disk so the audio can be extracted from it.
  if (!videoResult.filePath && videoResult.directUrl) {
    const sourcePath = path.join(outputDir, `${job.id}-source`);
    await downloadToFile(videoResult.directUrl, sourcePath, signal, (percent) =>
      reportProgress(job.id, 0, undefined, (percent * AUDIO_DOWNLOAD_SHARE) / 100),
    );
    videoResult.filePath = sourcePath;
  }
  if (!videoResult.filePath) {
    throw new BlazfetchError('FORMAT_UNAVAILABLE', 'Audio extraction requires a downloadable source file.');
  }

  const mp3Path = path.join(outputDir, `${job.id}.mp3`);
  const source = await validateMediaFile(videoResult.filePath, 'video').catch(() => undefined);
  const releaseConversion = await conversionSemaphore.acquire();
  try {
    await runFfmpeg({
      args: extractAudioArgs(videoResult.filePath, mp3Path, 192, conversionThreads),
      signal,
      timeoutMs: convertTimeoutMs(source?.durationSeconds),
      progress: source?.durationSeconds
        ? {
            durationSeconds: source.durationSeconds,
            onProgress: (percent) => reportProgress(job.id, 0, undefined, AUDIO_DOWNLOAD_SHARE + (percent * (99 - AUDIO_DOWNLOAD_SHARE)) / 100),
          }
        : undefined,
    });
  } finally {
    releaseConversion();
  }
  await fs.promises.rm(videoResult.filePath, { force: true });

  // A completed ffmpeg process doesn't guarantee a playable MP3 (e.g. the source had no usable
  // audio track at all), so this is validated exactly like the video path before being trusted.
  await validateMediaFile(mp3Path, 'audio');

  const stat = await fs.promises.stat(mp3Path);
  const result: DownloadResult = {
    filePath: mp3Path,
    filename: ctx.metadata ? buildFilename(ctx.filename, ctx.metadata, 'mp3') : path.basename(mp3Path),
    mimeType: 'audio/mpeg',
    bytes: stat.size,
  };

  await finalizeSuccess(job, result, startedAt, ctx);
  return { ...result, job: await refreshJob(job.id) };
}

/**
 * "The process exited 0" is not the same claim as "the file is playable." This probes the
 * actual output with ffprobe and, for video jobs producing a local MP4, transcodes to H.264/AAC
 * when the merged/remuxed result used an incompatible codec (VP9, AV1, HEVC, Opus, etc.) rather
 * than handing back a technically-complete file that shows black or won't play. A result that
 * only has a directUrl (proxied straight from the source CDN, never touching local disk) is
 * intentionally left unprobed — we're not downloading it ourselves to inspect it.
 *
 * UNSAFE_LARGE_VIDEO_STREAM_ENABLED skips this transcode once the downloaded file's real size reaches
 * UNSAFE_LARGE_VIDEO_MIN_BYTES, delivering the incompatible codec as-is to save the conversion's CPU cost — on by
 * default to protect server resources, meaning even an explicit mode=prepare ("Compatible") can hand back an
 * unplayable file once a video crosses that size; set it to false to always guarantee playability instead.
 */
export async function ensureValidAndCompatible(job: JobRecord, result: DownloadResult, signal: AbortSignal, fastConvert = false): Promise<DownloadResult> {
  if (!result.filePath) return result;

  const kind = job.requestedFormat.kind;
  const validation = await validateMediaFile(result.filePath, kind);

  if (kind === 'audio' || isBrowserCompatibleMp4(validation)) {
    return result;
  }

  if (env.UNSAFE_LARGE_VIDEO_STREAM_ENABLED && result.bytes >= env.UNSAFE_LARGE_VIDEO_MIN_BYTES) {
    // UNSAFE_LARGE_VIDEO_STREAM_ENABLED trades this video's playability on some phones for skipping the
    // conversion's CPU cost, once it is this big — deliberately, for every mode including mode=prepare.
    logger.info(
      { jobId: job.id, videoCodec: validation.videoCodec, bytes: result.bytes },
      'skipping compatibility transcode: video is at or above UNSAFE_LARGE_VIDEO_MIN_BYTES',
    );
    return result;
  }

  logger.info(
    { jobId: job.id, videoCodec: validation.videoCodec, audioCodec: validation.audioCodec },
    'transcoding to browser-compatible H.264/AAC MP4',
  );

  const dir = path.dirname(result.filePath);
  const compatiblePath = path.join(dir, `${job.id}-compatible.mp4`);
  reportProgress(job.id, result.bytes, undefined, DOWNLOAD_SHARE);
  // Wait for a free conversion slot (see MAX_CONCURRENT_CONVERSIONS): the job stays at DOWNLOAD_SHARE meanwhile.
  const releaseConversion = await conversionSemaphore.acquire();
  try {
    await runFfmpeg({
      args: transcodeToCompatibleMp4Args(result.filePath, compatiblePath, { fast: fastConvert, threads: conversionThreads }),
      signal,
      timeoutMs: convertTimeoutMs(validation.durationSeconds),
      progress: validation.durationSeconds
        ? {
            durationSeconds: validation.durationSeconds,
            onProgress: (percent) => reportProgress(job.id, result.bytes, undefined, DOWNLOAD_SHARE + (percent * (99 - DOWNLOAD_SHARE)) / 100),
          }
        : undefined,
    });
  } finally {
    releaseConversion();
  }
  await validateMediaFile(compatiblePath, 'video');
  await fs.promises.rm(result.filePath, { force: true });

  const stat = await fs.promises.stat(compatiblePath);
  return { ...result, filePath: compatiblePath, filename: `${path.parse(result.filename).name}.mp4`, mimeType: 'video/mp4', bytes: stat.size };
}

/** Facts about the media a download job worked on, for the statistics rows. */
interface StatContext {
  mediaKey?: string;
  fellBack?: boolean;
  recordFailure?: boolean;
  /** The requester's network (see networkKey), for the per-IP download limit on guests. */
  networkKey?: string;
}

async function finalizeSuccess(job: JobRecord, result: DownloadResult, startedAt: number, ctx: StatContext): Promise<void> {
  await updateJobStatus(job.id, result.directUrl ? 'ready' : 'completed', {
    filename: result.filename,
    mime_type: result.mimeType,
    downloaded_bytes: result.bytes,
    progress: result.directUrl ? 0 : 100,
    temp_path: result.filePath || null,
    source_url: result.directUrl ?? null,
    media_id: ctx.mediaKey ?? null,
  });
  // Preparation is not delivery. The response controller records success after all bytes are sent.
}

async function finalizeFailure(job: JobRecord, err: unknown, startedAt: number, cancelled: boolean, ctx: StatContext): Promise<void> {
  const code = err instanceof BlazfetchError ? err.code : 'DOWNLOAD_FAILED';
  const status = cancelled || (code === 'DOWNLOAD_FAILED' && err instanceof BlazfetchError && err.message === 'Request was cancelled.') ? 'cancelled' : 'failed';
  await updateJobStatus(job.id, status, { error_code: code, error_message: (err as Error).message });
  if (ctx.recordFailure !== false) await recordDownloadStat({
    jobId: job.id,
    platform: job.platform,
    format: job.requestedFormat.formatId,
    kind: job.requestedFormat.kind,
    userId: job.userId,
    guestId: job.guestId,
    success: false,
    mediaId: ctx.mediaKey,
    mode: 'prepare',
    fellBack: ctx.fellBack,
    processingDurationMs: Date.now() - startedAt,
    errorCode: code,
  });
  await cleanupJobTempDir(job.id);
}

async function refreshJob(id: string): Promise<JobRecord> {
  return getJob(id);
}
