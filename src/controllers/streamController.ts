import { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { BlazfetchError } from '../constants/errors';
import { logger } from '../lib/logger';
import { acquireUserDownloadSlot, globalDownloadSemaphore } from '../core/jobs/concurrencyLimiter';
import { openStream } from '../services/streamService';
import { recordDownloadStat } from '../services/statsService';

export const streamQuerySchema = z.object({
  url: z.string().min(1),
  // Omit (or pass "best") for the highest-quality video / audio automatically.
  formatId: z.string().min(1).optional().default('best'),
  kind: z.enum(['video', 'audio']).optional().default('video'),
  filename: z.string().max(200).optional(),
});

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * GET /api/v1/stream: pipes the media straight from yt-dlp/ffmpeg to the HTTP response. No file is
 * ever written to disk. It is a plain GET so a browser can start it by navigating to the URL.
 *
 * Before the first byte any failure is a normal JSON error. After it, the only way to signal a
 * problem is to abort the connection.
 */
export async function getStream(req: Request, res: Response): Promise<void> {
  const parsed = streamQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new BlazfetchError('VALIDATION_ERROR', 'Invalid query parameters.', parsed.error.flatten());
  }
  const { url, formatId, kind, filename } = parsed.data;

  const startedAt = Date.now();
  const abort = new AbortController();
  let clientClosed = false;
  let cleaned = false;
  let killSource: (() => void) | undefined;
  let bytes = 0;
  let statRecorded = false;

  const userKey = req.userId ?? req.guestId ?? 'anonymous';
  const releaseUser = acquireUserDownloadSlot(userKey, !req.userId); // throws SERVER_BUSY when over the limit
  let releaseGlobal: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (timer) clearTimeout(timer);
    abort.abort();
    killSource?.();
    releaseGlobal?.();
    releaseUser();
  };

  const recordStat = (success: boolean, errorCode?: string): void => {
    if (statRecorded) return;
    statRecorded = true;
    void recordDownloadStat({
      platform: platformForStat,
      format: formatId,
      kind,
      userId: req.userId,
      guestId: req.guestId,
      success,
      bytesTransferred: bytes,
      processingDurationMs: Date.now() - startedAt,
      errorCode,
    }).catch((err) => logger.warn({ requestId: req.requestId, err: (err as Error).message }, 'failed to record stream stat'));
  };

  let platformForStat = 'unknown';

  // Fires for both a finished response and a client that went away mid-download.
  res.on('close', () => {
    if (!res.writableFinished) {
      clientClosed = true;
      logger.info({ requestId: req.requestId, bytes }, 'stream client disconnected, stopping processes');
      recordStat(false, 'CLIENT_DISCONNECTED');
    }
    cleanup();
  });

  try {
    releaseGlobal = await globalDownloadSemaphore.acquire();
    if (clientClosed) {
      cleanup();
      return;
    }

    timer = setTimeout(() => {
      logger.warn({ requestId: req.requestId }, 'stream timed out, stopping processes');
      recordStat(false, 'PROCESS_TIMEOUT');
      cleanup();
      res.destroy();
    }, env.DOWNLOAD_TOTAL_TIMEOUT_MS);

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

    if (clientClosed) {
      cleanup();
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', opened.contentType);
    res.setHeader('Content-Disposition', contentDisposition(opened.filename));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no'); // stop nginx buffering the whole response
    if (opened.contentLength) res.setHeader('Content-Length', String(opened.contentLength));
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
    opened.stream.on('end', () => recordStat(true));
    opened.stream.pipe(res);
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
