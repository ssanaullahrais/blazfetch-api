import { Request, Response } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { startDownloadJob, runDownloadJob } from '../services/downloadService';
import { getJob, cancelJob, updateJobStatus, updateJobProgress } from '../core/jobs/jobManager';
import { cleanupJobTempDir } from '../core/jobs/tempFiles';
import { assertUrlIsSafeToFetch } from '../utils/url';
import { assertOwnership } from '../core/jobs/ownership';
import { safeFetch } from '../utils/safeFetch';
import { attachmentHeader } from '../utils/contentDisposition';
import { BlazfetchError } from '../constants/errors';
import { recordDownloadStat } from '../services/statsService';
import type { JobRecord } from '../core/jobs/jobTypes';

export const downloadBodySchema = z.object({
  url: z.string().min(1),
  // Omit (or pass "best") to get the highest-quality video / highest-bitrate audio automatically.
  formatId: z.string().min(1).optional().default('best'),
  kind: z.enum(['video', 'audio']),
  quality: z.string().optional(),
});

export async function postDownload(req: Request, res: Response): Promise<void> {
  const { url, formatId, kind, quality } = req.body as z.infer<typeof downloadBodySchema>;

  const job = await startDownloadJob({
    url,
    format: { formatId, kind, quality },
    requestId: req.requestId,
    userId: req.userId,
    guestId: req.guestId,
  });

  // The HTTP response returns immediately with the job handle; the actual resolve/download
  // work continues in the background so the client can poll or stream once it's ready.
  runDownloadJob(job, req.requestId).catch((err) => {
    logger.warn({ jobId: job.id, err: (err as Error).message }, 'download job failed');
  });

  res.status(202).json({ success: true, job });
}

export async function getDownloadStream(req: Request, res: Response): Promise<void> {
  const job = await getJob(req.params.id);
  assertOwnership(req, job);

  if (job.status === 'completed' && job.tempPath) {
    if (!fs.existsSync(job.tempPath)) {
      // The periodic sweep (or a restart) already removed the file: the job is over.
      await updateJobStatus(job.id, 'expired');
      throw new BlazfetchError('JOB_NOT_FOUND', 'This download has expired. Start a new one with POST /api/v1/download.');
    }
    const countBytes = trackDelivery(job, res);
    const finished = await streamLocalFile(job.tempPath, job.filename ?? 'download', job.mimeType ?? 'application/octet-stream', res, countBytes);
    // Only delete once the whole file reached the client; if the client dropped mid-transfer the
    // file stays so a retry still works, and the periodic sweep removes it later.
    if (finished) await cleanupJobTempDir(job.id);
    return;
  }

  if ((job.status === 'ready' || job.status === 'streaming') && job.sourceUrl) {
    await proxyRemoteFile(job, res, trackDelivery(job, res));
    return;
  }

  throw new BlazfetchError('JOB_NOT_FOUND', 'Download is not ready yet. Poll GET /api/v1/jobs/:id for status.');
}

export async function deleteDownload(req: Request, res: Response): Promise<void> {
  const job = await getJob(req.params.id);
  assertOwnership(req, job);
  await cancelJob(job.id);
  await cleanupJobTempDir(job.id);
  res.json({ success: true, job: await getJob(job.id) });
}

/** Resolves true when the whole file was sent, false when the client disconnected first. */
function trackDelivery(job: JobRecord, res: Response): (size: number) => void {
  let bytes = 0;
  let recorded = false;
  const startedAt = Date.now();
  const record = (finished: boolean): void => {
    if (recorded) return;
    recorded = true;
    const expected = Number(res.getHeader('Content-Length')) || undefined;
    const success = finished && res.statusCode < 400 && bytes > 0 && (expected === undefined || bytes === expected);
    void recordDownloadStat({
      jobId: job.id, platform: job.platform, mediaId: job.mediaId ?? undefined,
      format: job.requestedFormat.formatId, kind: job.requestedFormat.kind,
      userId: job.userId, guestId: job.guestId, success, mode: 'prepare',
      bytesTransferred: bytes, processingDurationMs: Date.now() - startedAt,
      errorCode: success ? undefined : 'DOWNLOAD_FAILED',
    }).catch((err) => logger.warn({ jobId: job.id, err: (err as Error).message }, 'failed to record delivery stat'));
  };
  res.once('finish', () => record(true));
  res.once('close', () => record(res.writableFinished));
  return (size) => { bytes += size; };
}

async function streamLocalFile(filePath: string, filename: string, mimeType: string, res: Response, countBytes: (size: number) => void): Promise<boolean> {
  const stat = await fs.promises.stat(filePath);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', attachmentHeader(filename));
  const stream = fs.createReadStream(filePath);
  stream.on('data', (chunk) => countBytes(chunk.length));
  return new Promise<boolean>((resolve, reject) => {
    stream.pipe(res);
    stream.on('error', (err) => {
      stream.destroy();
      reject(err);
    });
    res.on('close', () => {
      stream.destroy();
      resolve(res.writableFinished);
    });
  });
}

async function proxyRemoteFile(job: Awaited<ReturnType<typeof getJob>>, res: Response, countBytes: (size: number) => void): Promise<void> {
  const sourceUrl = job.sourceUrl as string;
  await assertUrlIsSafeToFetch(sourceUrl);
  await updateJobStatus(job.id, 'streaming');

  const upstream = await safeFetch(sourceUrl);
  if (!upstream.ok || !upstream.body) {
    await updateJobStatus(job.id, 'failed', { error_code: 'DOWNLOAD_FAILED', error_message: `Upstream responded with ${upstream.status}` });
    throw new BlazfetchError('DOWNLOAD_FAILED', 'Failed to fetch media from the source.');
  }

  const totalBytes = Number(upstream.headers.get('content-length')) || undefined;
  res.setHeader('Content-Type', job.mimeType ?? upstream.headers.get('content-type') ?? 'application/octet-stream');
  if (totalBytes) res.setHeader('Content-Length', String(totalBytes));
  res.setHeader('Content-Disposition', attachmentHeader(job.filename ?? 'download'));

  let downloaded = 0;
  let clientGone = false;
  const reader = upstream.body.getReader();
  // Stop pulling from the source as soon as the client goes away instead of reading it to the end.
  res.on('close', () => {
    if (res.writableFinished) return;
    clientGone = true;
    void reader.cancel().catch(() => undefined);
  });
  try {
    // Streams bytes through without ever buffering the full file on disk or in memory.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      if (clientGone) break;
      countBytes(value.byteLength);
      res.write(value);
      void updateJobProgress(job.id, downloaded, totalBytes, totalBytes ? (downloaded / totalBytes) * 100 : undefined);
    }
    if (clientGone) {
      await updateJobStatus(job.id, 'cancelled', { downloaded_bytes: downloaded });
      return;
    }
    res.end();
    await updateJobStatus(job.id, 'completed', { progress: 100, downloaded_bytes: downloaded });
  } catch (err) {
    await updateJobStatus(job.id, 'failed', { error_code: 'DOWNLOAD_FAILED', error_message: (err as Error).message });
    throw err;
  }
}
