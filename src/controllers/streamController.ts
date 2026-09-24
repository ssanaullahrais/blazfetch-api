import fs from 'node:fs';
import { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { BlazfetchError } from '../constants/errors';
import { logger } from '../lib/logger';
import { acquireUserDownloadSlot, globalDownloadSemaphore } from '../core/jobs/concurrencyLimiter';
import { cancelJob } from '../core/jobs/jobManager';
import { cleanupJobTempDir } from '../core/jobs/tempFiles';
import { JobRecord } from '../core/jobs/jobTypes';
import { buildFilename, openProxy, openStream } from '../services/streamService';
import { runDownloadJob, startDownloadJob } from '../services/downloadService';
import { fetchMedia } from '../services/fetchService';
import { recordDownloadStat } from '../services/statsService';
import { mediaKeyForResponse } from '../core/media/mediaPath';

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
const FALLBACK_CODES = new Set(['DOWNLOAD_FAILED', 'EXTRACTOR_FAILED', 'PROCESS_TIMEOUT']);

export function isFallbackEligible(err: unknown): boolean {
  if (!(err instanceof BlazfetchError)) return false;
  if ((err.details as { streamUnsupported?: boolean } | undefined)?.streamUnsupported) return true;
  return FALLBACK_CODES.has(err.code);
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * GET /api/v1/stream: one URL, three delivery modes. It is a plain GET so a browser can start it by
 * navigating to the URL.
 *
 * - stream: yt-dlp/ffmpeg output is piped straight to the response; no file on disk.
 * - prepare: the file is built in TEMP_DIR first (merge/transcode, H.264/AAC guaranteed), then sent
 *   and deleted, all within this one request.
 * - auto: stream first; if that fails before the first byte, prepare in the same request.
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
      res.destroy();
    }, env.DOWNLOAD_TOTAL_TIMEOUT_MS);
  };

  res.once('finish', () => {
    const complete = res.statusCode < 400 && bytes > 0 && (expectedLength === undefined || bytes === expectedLength);
    recordStat(complete, complete ? undefined : 'DOWNLOAD_FAILED');
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
    const userKey = req.userId ?? req.guestId ?? 'anonymous';
    releaseUser = acquireUserDownloadSlot(userKey, !req.userId); // throws SERVER_BUSY when over the limit
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
    });
    killSource = opened.kill;
    platformForStat = opened.platform;
    mediaKeyForStat = opened.mediaKey;
    firstByteMs = Date.now() - startedAt;
    if (clientClosed) return;

    res.status(200);
    announceStart();
    res.setHeader('Content-Type', opened.contentType);
    res.setHeader('Content-Disposition', contentDisposition(opened.filename));
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

  /** Prepare: build the file with the job pipeline (same as POST /download), send it, delete it. */
  const runPrepare = async (): Promise<void> => {
    const job = await startDownloadJob({
      url,
      format: { formatId, kind },
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
      result = await runDownloadJob(job, req.requestId, { fellBack, recordFailure: false });
    } finally {
      prepareFinished = true;
    }
    if (clientClosed) {
      await cleanupJobTempDir(job.id);
      return;
    }

    const media = await fetchMedia({ url, requestId: req.requestId, internal: true }).catch(() => undefined);
    mediaKeyForStat = result.job.mediaId ?? (media ? mediaKeyForResponse(media) : undefined);
    const ext = (result.filename.split('.').pop() ?? 'mp4').toLowerCase();
    const name = media ? buildFilename(filename, media, ext) : result.filename;

    armTimeout();
    firstByteMs = Date.now() - startedAt;
    res.status(200);
    announceStart();
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', contentDisposition(name));
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
    if (mode !== 'prepare') {
      try {
        await runStream();
        return;
      } catch (err) {
        if (mode === 'stream' || clientClosed || res.headersSent || !isFallbackEligible(err)) throw err;
        logger.warn(
          { requestId: req.requestId, code: (err as BlazfetchError).code, err: (err as Error).message },
          'direct stream failed before the first byte, falling back to prepare mode',
        );
        fellBack = true;
        stopStreamAttempt();
        abort = new AbortController(); // the stream attempt's signal is spent
      }
    }

    await runPrepare();
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
