import path from 'node:path';
import fs from 'node:fs';
import { validateAndNormalizeUrl } from '../utils/url';
import { getAdapter } from '../core/adapters/registry';
import { DownloadResult } from '../core/adapters/types';
import { globalDownloadSemaphore, acquireUserDownloadSlot } from '../core/jobs/concurrencyLimiter';
import { createJob, getJob, getJobSignal, updateJobProgress, updateJobStatus, clearJobController } from '../core/jobs/jobManager';
import { jobTempDir, cleanupJobTempDir } from '../core/jobs/tempFiles';
import { runFfmpeg, extractAudioArgs, transcodeToCompatibleMp4Args } from '../core/ffmpeg/ffmpegRunner';
import { isBrowserCompatibleMp4, validateMediaFile } from '../core/ffmpeg/ffprobe';
import { pickBestAudioFormat, pickBestVideoFormat } from '../core/adapters/formatSelection';
import { logger } from '../lib/logger';
import { recordDownloadStat } from './statsService';
import { fetchMedia } from './fetchService';
import { fetchAudio } from './audioService';
import { JobRecord, RequestedFormat } from '../core/jobs/jobTypes';
import { BlazfetchError } from '../constants/errors';

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
    const media = await fetchMedia({ url, requestId });
    const best = pickBestVideoFormat(media.formats);
    if (!best) throw new BlazfetchError('FORMAT_UNAVAILABLE', 'No video formats are available for this media.');
    return { ...format, formatId: best.formatId, quality: best.quality };
  }

  const audio = await fetchAudio({ url, requestId });
  const best = pickBestAudioFormat(audio.audioFormats);
  if (!best) throw new BlazfetchError('FORMAT_UNAVAILABLE', 'No audio formats are available for this media.');
  return { ...format, formatId: best.formatId, quality: best.quality };
}

export async function startDownloadJob(params: StartDownloadParams): Promise<JobRecord> {
  const normalizedUrl = validateAndNormalizeUrl(params.url);
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
export async function runDownloadJob(job: JobRecord, requestId: string): Promise<RunDownloadResult> {
  const normalizedUrl = validateAndNormalizeUrl(job.canonicalUrl);
  const adapter = getAdapter(normalizedUrl);
  const signal = getJobSignal(job.id);

  const userKey = job.userId ?? job.guestId ?? 'anonymous';
  const releaseUserSlot = acquireUserDownloadSlot(userKey, !job.userId);
  const releaseGlobalSlot = await globalDownloadSemaphore.acquire();

  const startedAt = Date.now();
  await updateJobStatus(job.id, 'preparing');

  try {
    const outputDir = jobTempDir(job.id);
    let effectiveFormatId = job.requestedFormat.formatId;

    if (job.requestedFormat.kind === 'audio') {
      const metadata = await fetchMedia({ url: job.canonicalUrl, requestId });
      const hasStandaloneAudio = metadata.audioFormats.some((f) => f.formatId === job.requestedFormat.formatId);
      if (!hasStandaloneAudio) {
        return await runAudioExtraction(job, adapter, normalizedUrl, outputDir, signal, requestId, startedAt);
      }
    } else {
      const metadata = await fetchMedia({ url: job.canonicalUrl, requestId });
      const format = metadata.formats.find((f) => f.formatId === job.requestedFormat.formatId);
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
        onProgress: (progress) => {
          void updateJobProgress(job.id, progress.downloadedBytes, progress.totalBytes, progress.percent);
        },
      },
    );

    result = await ensureValidAndCompatible(job, result, signal);
    await finalizeSuccess(job, result, startedAt);
    return { ...result, job: await refreshJob(job.id) };
  } catch (err) {
    await finalizeFailure(job, err, startedAt, signal.aborted);
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
): Promise<RunDownloadResult> {
  await updateJobStatus(job.id, 'streaming');

  const videoResult = await adapter.download(
    { requestId, normalizedUrl },
    {
      formatId: job.requestedFormat.formatId,
      kind: 'video',
      outputDir,
      signal,
      onProgress: (progress) => {
        void updateJobProgress(job.id, progress.downloadedBytes, progress.totalBytes, progress.percent ? progress.percent / 2 : undefined);
      },
    },
  );

  if (!videoResult.filePath) {
    throw new BlazfetchError('FORMAT_UNAVAILABLE', 'Audio extraction requires a downloadable source file.');
  }

  const mp3Path = path.join(outputDir, `${job.id}.mp3`);
  await runFfmpeg({ args: extractAudioArgs(videoResult.filePath, mp3Path), signal });
  await fs.promises.rm(videoResult.filePath, { force: true });

  // A completed ffmpeg process doesn't guarantee a playable MP3 (e.g. the source had no usable
  // audio track at all), so this is validated exactly like the video path before being trusted.
  await validateMediaFile(mp3Path, 'audio');

  const stat = await fs.promises.stat(mp3Path);
  const result: DownloadResult = {
    filePath: mp3Path,
    filename: path.basename(mp3Path),
    mimeType: 'audio/mpeg',
    bytes: stat.size,
  };

  await finalizeSuccess(job, result, startedAt);
  return { ...result, job: await refreshJob(job.id) };
}

/**
 * "The process exited 0" is not the same claim as "the file is playable." This probes the
 * actual output with ffprobe and, for video jobs producing a local MP4, transcodes to H.264/AAC
 * when the merged/remuxed result used an incompatible codec (VP9, AV1, HEVC, Opus, etc.) rather
 * than handing back a technically-complete file that shows black or won't play. A result that
 * only has a directUrl (proxied straight from the source CDN, never touching local disk) is
 * intentionally left unprobed — we're not downloading it ourselves to inspect it.
 */
async function ensureValidAndCompatible(job: JobRecord, result: DownloadResult, signal: AbortSignal): Promise<DownloadResult> {
  if (!result.filePath) return result;

  const kind = job.requestedFormat.kind;
  const validation = await validateMediaFile(result.filePath, kind);

  if (kind === 'audio' || isBrowserCompatibleMp4(validation)) {
    return result;
  }

  logger.info(
    { jobId: job.id, videoCodec: validation.videoCodec, audioCodec: validation.audioCodec },
    'transcoding to browser-compatible H.264/AAC MP4',
  );

  const dir = path.dirname(result.filePath);
  const compatiblePath = path.join(dir, `${job.id}-compatible.mp4`);
  await runFfmpeg({ args: transcodeToCompatibleMp4Args(result.filePath, compatiblePath), signal });
  await validateMediaFile(compatiblePath, 'video');
  await fs.promises.rm(result.filePath, { force: true });

  const stat = await fs.promises.stat(compatiblePath);
  return { ...result, filePath: compatiblePath, filename: path.basename(compatiblePath), mimeType: 'video/mp4', bytes: stat.size };
}

async function finalizeSuccess(job: JobRecord, result: DownloadResult, startedAt: number): Promise<void> {
  await updateJobStatus(job.id, result.directUrl ? 'ready' : 'completed', {
    filename: result.filename,
    mime_type: result.mimeType,
    downloaded_bytes: result.bytes,
    progress: result.directUrl ? 0 : 100,
    temp_path: result.filePath || null,
    source_url: result.directUrl ?? null,
  });
  await recordDownloadStat({
    jobId: job.id,
    platform: job.platform,
    format: job.requestedFormat.formatId,
    kind: job.requestedFormat.kind,
    userId: job.userId,
    guestId: job.guestId,
    success: true,
    bytesTransferred: result.bytes,
    processingDurationMs: Date.now() - startedAt,
  });
}

async function finalizeFailure(job: JobRecord, err: unknown, startedAt: number, cancelled: boolean): Promise<void> {
  const code = err instanceof BlazfetchError ? err.code : 'DOWNLOAD_FAILED';
  const status = cancelled || (code === 'DOWNLOAD_FAILED' && err instanceof BlazfetchError && err.message === 'Request was cancelled.') ? 'cancelled' : 'failed';
  await updateJobStatus(job.id, status, { error_code: code, error_message: (err as Error).message });
  await recordDownloadStat({
    jobId: job.id,
    platform: job.platform,
    format: job.requestedFormat.formatId,
    kind: job.requestedFormat.kind,
    userId: job.userId,
    guestId: job.guestId,
    success: false,
    processingDurationMs: Date.now() - startedAt,
    errorCode: code,
  });
  await cleanupJobTempDir(job.id);
}

async function refreshJob(id: string): Promise<JobRecord> {
  return getJob(id);
}
