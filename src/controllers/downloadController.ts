import { Request, Response } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { startDownloadJob, runDownloadJob } from '../services/downloadService';
import { getJob, cancelJob, updateJobStatus, updateJobProgress } from '../core/jobs/jobManager';
import { cleanupJobTempDir } from '../core/jobs/tempFiles';
import { assertUrlIsSafeToFetch } from '../utils/url';
import { BlazfetchError } from '../constants/errors';

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

  if (job.status === 'completed' && job.tempPath) {
    await streamLocalFile(job.tempPath, job.filename ?? 'download', job.mimeType ?? 'application/octet-stream', res);
    await cleanupJobTempDir(job.id);
    return;
  }

  if ((job.status === 'ready' || job.status === 'streaming') && job.sourceUrl) {
    await proxyRemoteFile(job, res);
    return;
  }

  throw new BlazfetchError('JOB_NOT_FOUND', 'Download is not ready yet. Poll GET /api/v1/jobs/:id for status.');
}

export async function deleteDownload(req: Request, res: Response): Promise<void> {
  const job = await getJob(req.params.id);
  await cancelJob(job.id);
  await cleanupJobTempDir(job.id);
  res.json({ success: true, job: await getJob(job.id) });
}

async function streamLocalFile(filePath: string, filename: string, mimeType: string, res: Response): Promise<void> {
  const stat = await fs.promises.stat(filePath);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  const stream = fs.createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.pipe(res);
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

async function proxyRemoteFile(job: Awaited<ReturnType<typeof getJob>>, res: Response): Promise<void> {
  const sourceUrl = job.sourceUrl as string;
  await assertUrlIsSafeToFetch(sourceUrl);
  await updateJobStatus(job.id, 'streaming');

  const upstream = await fetch(sourceUrl);
  if (!upstream.ok || !upstream.body) {
    await updateJobStatus(job.id, 'failed', { error_code: 'DOWNLOAD_FAILED', error_message: `Upstream responded with ${upstream.status}` });
    throw new BlazfetchError('DOWNLOAD_FAILED', 'Failed to fetch media from the source.');
  }

  const totalBytes = Number(upstream.headers.get('content-length')) || undefined;
  res.setHeader('Content-Type', job.mimeType ?? upstream.headers.get('content-type') ?? 'application/octet-stream');
  if (totalBytes) res.setHeader('Content-Length', String(totalBytes));
  res.setHeader('Content-Disposition', `attachment; filename="${(job.filename ?? 'download').replace(/"/g, '')}"`);

  let downloaded = 0;
  const reader = upstream.body.getReader();
  try {
    // Streams bytes through without ever buffering the full file on disk or in memory.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      res.write(value);
      void updateJobProgress(job.id, downloaded, totalBytes, totalBytes ? (downloaded / totalBytes) * 100 : undefined);
    }
    res.end();
    await updateJobStatus(job.id, 'completed', { progress: 100, downloaded_bytes: downloaded });
  } catch (err) {
    await updateJobStatus(job.id, 'failed', { error_code: 'DOWNLOAD_FAILED', error_message: (err as Error).message });
    throw err;
  }
}
