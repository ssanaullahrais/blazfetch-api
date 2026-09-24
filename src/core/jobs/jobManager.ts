import { getDb } from '../../db';
import { JobRecord, JobStatus, RequestedFormat } from './jobTypes';

/** Tracks the running child process's AbortController per job so cancellation can reach it
 *  even though the HTTP request that started the job may have already returned. */
const activeAbortControllers = new Map<string, AbortController>();

export async function createJob(params: {
  platform: string;
  mediaId: string | null;
  canonicalUrl: string;
  requestedFormat: RequestedFormat;
  userId?: string | null;
  guestId?: string | null;
}): Promise<JobRecord> {
  const job = await getDb().jobs.create(params);
  activeAbortControllers.set(job.id, new AbortController());
  return job;
}

export async function getJob(id: string): Promise<JobRecord> {
  return getDb().jobs.get(id);
}

export function getJobSignal(id: string): AbortSignal {
  const controller = activeAbortControllers.get(id) ?? new AbortController();
  activeAbortControllers.set(id, controller);
  return controller.signal;
}

export async function updateJobStatus(id: string, status: JobStatus, extra: Partial<Record<string, unknown>> = {}): Promise<void> {
  await getDb().jobs.updateStatus(id, status, extra);
}

export async function updateJobProgress(id: string, downloadedBytes: number, totalBytes?: number, percent?: number): Promise<void> {
  await getDb().jobs.updateProgress(id, downloadedBytes, totalBytes, percent);
}

export async function cancelJob(id: string): Promise<void> {
  const controller = activeAbortControllers.get(id);
  controller?.abort();
  await updateJobStatus(id, 'cancelled');
}

export function clearJobController(id: string): void {
  activeAbortControllers.delete(id);
}
