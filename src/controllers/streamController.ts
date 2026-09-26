import fs from 'node:fs';
import { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { BlazfetchError } from '../constants/errors';
import { logger } from '../lib/logger';
import { acquireVisitorDownloadSlots, globalDownloadSemaphore } from '../core/jobs/concurrencyLimiter';
import { cancelJob } from '../core/jobs/jobManager';
import { cleanupJobTempDir } from '../core/jobs/tempFiles';
import { JobRecord } from '../core/jobs/jobTypes';
import { buildFilename, openProxy, openStream } from '../services/streamService';
import { runDownloadJob, startDownloadJob } from '../services/downloadService';
import { fetchMedia } from '../services/fetchService';
import { recordDownloadStat } from '../services/statsService';
import { mediaKeyForResponse } from '../core/media/mediaPath';
import { networkKey } from '../utils/clientKey';
import { attachmentHeader } from '../utils/contentDisposition';

export const DOWNLOAD_MODES = ['stream', 'prepare', 'auto'] as const;

export const streamQuerySchema = z.object({
  url: z.string().min(1),
  // Omit (or pass "best") for the highest-quality video / audio automatically.
  formatId: z.string().min(1).optional().default('best'),
  kind: z.enum(['video', 'audio']).optional().default('video'),
  filename: z.string().max(200).optional(),
  // A random id chosen by the page. When bytes start flowing the server sets the short-lived cookie
  // `blazfetch_dl_<token>`, so a page that starts the download by navigation can tell it began.
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  // stream: pipe straight through. prepare: build the file on the server first, then send it.
  // auto: try stream, and if that fails before any byte, prepare instead. Default: DEFAULT_DOWNLOAD_MODE.
  mode: z.enum(DOWNLOAD_MODES).optional(),
});

/** Failures that streaming can cause but preparing the file can still get around. */
const FALLBACK_CODES = new Set(['DOWNLOAD_FAILED', 'EXTRACTOR_FAILED', 'PROCESS_TIMEOUT', 'FORMAT_UNAVAILABLE']);

export function isFallbackEligible(err: unknown): boolean {
  if (!(err instanceof BlazfetchError)) return false;
  if ((err.details as { streamUnsupported?: boolean } | undefined)?.streamUnsupported) return true;
  return FALLBACK_CODES.has(err.code);
}

/**
 * GET /api/v1/stream: one URL, three delivery modes. It is a plain GET so a browser can start it by
 * navigating to the URL.
 *
 * - stream: yt-dlp/ffmpeg output is piped straight to the response; no file on disk.
 * - prepare: the file is built in TEMP_DIR first (merge/transcode, H.264/AAC guaranteed), then sent
 *   and deleted, all within this one request.
 * - auto and stream (Fastest in the app): stream first; if that fails before the first byte, prepare in the same
 *   request. An H.264 source (even one that needs merging with an audio track) still streams live either way; a
 *   VP9/AV1/HEVC source, or HLS, is refused before any byte is sent and prepared into a normal H.264 MP4 instead,
 *   since phones cannot play those live-merged as-is — shipping a broken file just to be fast helps no one. Once
 *   prepare does run, stream always uses ffmpeg's quickest (larger-output) preset; auto only does once the source
 *   is big enough for that to matter (see AUTO_FALLBACK_FAST_CONVERT_MIN_BYTES) — that preset choice is now the
 *   only thing that tells the two modes apart.
 *
 * UNSAFE_LARGE_VIDEO_STREAM_ENABLED (on by default) overrides all of the above once a video's real size reaches
 * UNSAFE_LARGE_VIDEO_MIN_BYTES: it is delivered in its original, possibly phone-unplayable codec instead of being
 * made compatible, for every mode including an explicit mode=prepare — see ensureValidAndCompatible.
 *
 * Before the first byte any failure is a normal JSON error. After it, the only way to signal a
 * problem is to abort the connection (so auto can only fall back before bytes are sent).
 */
export async function getStream(req: Request, res: Response): Promise<void> {
  const parsed = streamQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new BlazfetchError('VALIDATION_ERROR', 'Invalid query parameters.', parsed.error.flatten());
  }
  const { url, formatId, kind, filename, token } = parsed.data;
  const mode = parsed.data.mode ?? env.DEFAULT_DOWNLOAD_MODE;

  const startedAt = Date.now();
  let abort = new AbortController();
  let clientClosed = false;
  let cleaned = false;
  let killSource: (() => void) | undefined;
  let bytes = 0;
  let statRecorded = false;
  let platformForStat = 'unknown';
  let mediaKeyForStat: string | undefined;
  let firstByteMs: number | undefined;
  let fellBack = false;
  /** Expected response size, when known. */
  let expectedLength: number | undefined;
  let deliveredMode: 'stream' | 'prepare' = 'stream';
  let timer: NodeJS.Timeout | undefined;
  let releaseUser: (() => void) | undefined;
  let releaseGlobal: (() => void) | undefined;
  let prepareJob: JobRecord | undefined;
  let prepareFinished = false;
  /** The format the prepare step builds: the requested one first, then "best" if that cannot be produced. */
  let prepareFormatId = formatId;
  /** Set when auto's phone-safety fallback reports a big source, so prepare uses the quicker ffmpeg preset. */
  let fastConvertOverride = false;

  const releaseSlots = (): void => {
    releaseGlobal?.();
    releaseGlobal = undefined;
    releaseUser?.();
    releaseUser = undefined;
  };

  /** Stops the streaming attempt (processes, timer, slots) without ending the request. */
  const stopStreamAttempt = (): void => {
    if (timer) clearTimeout(timer);
    abort.abort();
    killSource?.();
    releaseSlots();
  };

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    stopStreamAttempt();
    if (prepareJob && !prepareFinished) void cancelJob(prepareJob.id).catch(() => undefined);
  };

  const recordStat = (success: boolean, errorCode?: string): void => {
    if (statRecorded) return;
    statRecorded = true;
    void recordDownloadStat({
      platform: platformForStat,
      mediaId: mediaKeyForStat,
      format: formatId,
      kind,
      userId: req.userId,
      guestId: req.guestId,
      success,
      mode: deliveredMode,
      firstByteMs,
      fellBack,
      bytesTransferred: bytes,
      processingDurationMs: Date.now() - startedAt,
      errorCode,
    }).catch((err) => logger.warn({ requestId: req.requestId, err: (err as Error).message }, 'failed to record stream stat'));
  };

  const armTimeout = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      logger.warn({ requestId: req.requestId, mode }, 'download timed out, stopping processes');
      recordStat(false, 'PROCESS_TIMEOUT');
      cleanup();
      // Not a single byte has gone out yet: say so with a real JSON error instead of just resetting the
      // connection, so a client watching for a response (the hidden download frame) sees a clear failure
      // right away instead of waiting out its own much longer give-up timer for a reply that never comes.
      if (!res.headersSent) {
        res.status(504).json({
          success: false,
          error: { code: 'PROCESS_TIMEOUT', message: 'The download took too long and was stopped.' },
          requestId: req.requestId,
        });
        return;
      }
      res.destroy();
    }, env.DOWNLOAD_TOTAL_TIMEOUT_MS);
  };

  res.once('finish', () => {
    const complete = res.statusCode < 400 && bytes > 0 && (expectedLength === undefined || bytes === expectedLength);
    recordStat(complete, complete ? undefined : 'DOWNLOAD_FAILED');
    releaseSlots(); // the client already has the whole response: free the slots now, not on the later 'close'
  });

  // Source EOF alone does not prove the HTTP response finished sending to the client.
  res.on('close', () => {
    const sentKnownLength = res.statusCode < 400 && expectedLength !== undefined && bytes === expectedLength;
    if (!res.writableFinished && !sentKnownLength) {
      clientClosed = true;
      logger.info({ requestId: req.requestId, bytes, mode }, 'client disconnected, stopping processes');
      recordStat(false, 'CLIENT_DISCONNECTED');
    } else if (sentKnownLength) {
      // Some browsers close immediately after reading Content-Length, before upstream EOF.
      recordStat(true);
    }
    cleanup();
  });

  /** Tells the page the download has really started (headers are about to go out, so this cookie travels with them). */
  const announceStart = (): void => {
    if (token) res.cookie(`blazfetch_dl_${token}`, '1', { maxAge: 60_000, sameSite: 'lax', path: '/', httpOnly: false });
  };

  /** Direct stream: resolves once the response has been handed to the pipe (or the client left). */
  const runStream = async (): Promise<void> => {
    releaseUser = acquireVisitorDownloadSlots({ userId: req.userId, guestId: req.guestId, networkKey: networkKey(req), kind }); // throws SERVER_BUSY when over the limit
    releaseGlobal = await globalDownloadSemaphore.acquire();
    if (clientClosed) return;

    armTimeout();
    const opened = await openStream({
      url,
      formatId,
      kind,
      filename,
      requestId: req.requestId,
      userId: req.userId,
      guestId: req.guestId,
      signal: abort.signal,
      // Both auto and stream ("Fastest") refuse a pick that would come out unplayable on phones (VP9/AV1/HEVC, or
      // HLS) before any byte is sent, so it falls back to prepare instead — shipping a broken file just to be
      // fast helps no one. An H.264 merge needs no such fallback and keeps streaming live either way. Once
      // prepare runs, fastConvert (below) is still what tells the two modes apart: stream always uses the
      // quicker, larger-output ffmpeg preset; auto only does once the source is big enough for that to matter.
    });
    killSource = opened.kill;
    platformForStat = opened.platform;
    mediaKeyForStat = opened.mediaKey;
    firstByteMs = Date.now() - startedAt;
    if (clientClosed) return;

    res.status(200);
    announceStart();
    res.setHeader('Content-Type', opened.contentType);
    res.setHeader('Content-Disposition', attachmentHeader(opened.filename));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no'); // stop nginx buffering the whole response
    res.setHeader('X-Blazfetch-Mode', 'stream');
    if (opened.contentLength) {
      res.setHeader('Content-Length', String(opened.contentLength));
      expectedLength = opened.contentLength;
    }
    // No Content-Length otherwise: Node falls back to chunked transfer encoding.

    bytes += opened.firstChunk.length;
    res.write(opened.firstChunk);

    opened.stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    opened.stream.on('error', (err) => {
      const code = err instanceof BlazfetchError ? err.code : 'DOWNLOAD_FAILED';
      logger.warn({ requestId: req.requestId, code, err: err.message, bytes }, 'stream failed after the first byte, aborting connection');
      recordStat(false, code);
      cleanup();
      res.destroy();
    });
    opened.stream.pipe(res);
  };

  /** Drops a failed prepare attempt (job and temp files) before trying again. */
  const cleanupPrepare = async (): Promise<void> => {
    if (prepareJob) {
      await cancelJob(prepareJob.id).catch(() => undefined);
      await cleanupJobTempDir(prepareJob.id).catch(() => undefined);
    }
    prepareJob = undefined;
    prepareFinished = false;
  };

  /** Prepare: build the file with the job pipeline (same as POST /download), send it, delete it. */
  const runPrepare = async (): Promise<void> => {
    const job = await startDownloadJob({
      url,
      format: { formatId: prepareFormatId, kind },
      requestId: req.requestId,
      userId: req.userId,
      guestId: req.guestId,
    });
    prepareJob = job;
    platformForStat = job.platform;
    deliveredMode = 'prepare';
    if (clientClosed) {
      await cancelJob(job.id).catch(() => undefined);
      return;
    }

    let result: Awaited<ReturnType<typeof runDownloadJob>>;
    try {
      // Fastest (mode=stream) always converts with ffmpeg's quickest settings when a conversion cannot be avoided;
      // auto does too, but only once the source is big enough that the time/CPU saved actually matters.
      result = await runDownloadJob(job, req.requestId, {
        fellBack,
        recordFailure: false,
        networkKey: networkKey(req),
        fastConvert: mode === 'stream' || fastConvertOverride,
      });
    } finally {
      prepareFinished = true;
    }
    if (clientClosed) {
      await cleanupJobTempDir(job.id);
      return;
    }

    const media = await fetchMedia({ url, requestId: req.requestId, internal: true }).catch(() => undefined);
    mediaKeyForStat = result.job.mediaId ?? (media ? mediaKeyForResponse(media) : undefined);
    const fileExt = (result.filename.split('.').pop() ?? 'mp4').toLowerCase();
    // An audio-only MP4 is an M4A file: name it so, or phones file it under videos.
    const ext = kind === 'audio' && fileExt === 'mp4' ? 'm4a' : fileExt;
    const name = media ? buildFilename(filename, media, ext) : result.filename;

    armTimeout();
    firstByteMs = Date.now() - startedAt;
    res.status(200);
    announceStart();
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', attachmentHeader(name));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Blazfetch-Mode', 'prepare');

    if (result.filePath) {
      const stat = await fs.promises.stat(result.filePath);
      if (stat.size > env.MAX_DOWNLOAD_SIZE_BYTES) {
        res.removeHeader('Content-Disposition');
        throw new BlazfetchError('FILE_TOO_LARGE', 'The file exceeds the maximum allowed download size.');
      }
      res.setHeader('Content-Length', String(stat.size));
      expectedLength = stat.size;
      const file = fs.createReadStream(result.filePath);
      file.on('data', (chunk) => { bytes += chunk.length; });
      file.on('error', (err) => {
        recordStat(false, 'DOWNLOAD_FAILED');
        logger.warn({ requestId: req.requestId, err: err.message }, 'reading the prepared file failed');
        res.destroy();
      });
      // Always remove the file once the response is over, whether it finished or the client left.
      res.once('close', () => void cleanupJobTempDir(job.id));
      file.pipe(res);
      return;
    }

    if (result.directUrl) {
      const source = await openProxy(result.directUrl, abort.signal, req.requestId);
      killSource = source.kill;
      if (source.contentLength) {
        expectedLength = source.contentLength;
        res.setHeader('Content-Length', String(source.contentLength));
      }
      source.stream.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      source.stream.on('error', (err) => {
        recordStat(false, 'DOWNLOAD_FAILED');
        logger.warn({ requestId: req.requestId, err: err.message }, 'proxying the prepared source failed');
        res.destroy();
      });
      source.stream.pipe(res);
      return;
    }

    throw new BlazfetchError('DOWNLOAD_FAILED', 'The prepared download had no file to send.');
  };

  try {
    // Audio always goes through prepare, whatever the mode: it is a much smaller, cheaper build than video (no
    // heavy H.264 transcode, just a real audio track or a quick MP3 conversion), so there is no speed trade-off
    // worth risking an incompatible codec for — and UNSAFE_LARGE_VIDEO_STREAM_ENABLED's size cutoff (built for big
    // video conversions) never applies to it either way.
    if (mode !== 'prepare' && kind !== 'audio') {
      try {
        await runStream();
        return;
      } catch (err) {
        if (clientClosed || res.headersSent || !isFallbackEligible(err)) throw err;
        logger.warn(
          { requestId: req.requestId, code: (err as BlazfetchError).code, err: (err as Error).message },
          'direct stream failed before the first byte, falling back to prepare mode',
        );
        fellBack = true;
        stopStreamAttempt();
        abort = new AbortController(); // the stream attempt's signal is spent
        const sizeHint = (err instanceof BlazfetchError ? (err.details as { filesizeBytes?: number } | undefined)?.filesizeBytes : undefined) ?? 0;
        if (sizeHint >= env.AUTO_FALLBACK_FAST_CONVERT_MIN_BYTES) fastConvertOverride = true;
      }
    }

    try {
      await runPrepare();
    } catch (err) {
      // The requested quality could not be produced: deliver the best one instead of failing the download.
      if (clientClosed || res.headersSent || !isFallbackEligible(err) || prepareFormatId === 'best') throw err;
      logger.warn({ requestId: req.requestId, formatId, err: (err as Error).message }, 'prepare failed for the requested format, retrying with best');
      await cleanupPrepare();
      prepareFormatId = 'best';
      await runPrepare();
    }
  } catch (err) {
    const code = err instanceof BlazfetchError ? err.code : 'INTERNAL_ERROR';
    recordStat(false, code);
    cleanup();
    if (clientClosed || res.headersSent) {
      res.destroy();
      return;
    }
    throw err;
  }
}
