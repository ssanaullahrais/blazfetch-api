import { pool } from '../../db/pool';
import { BlazfetchError } from '../../constants/errors';
import { JobRecord, JobStatus, RequestedFormat } from './jobTypes';

/** Tracks the running child process's AbortController per job so cancellation can reach it
 *  even though the HTTP request that started the job may have already returned. */
const activeAbortControllers = new Map<string, AbortController>();

function rowToJob(row: Record<string, unknown>): JobRecord {
  return {
    id: row.id as string,
    status: row.status as JobStatus,
    platform: row.platform as string,
    mediaId: (row.media_id as string) ?? null,
    canonicalUrl: row.canonical_url as string,
    requestedFormat: row.requested_format as RequestedFormat,
    userId: (row.user_id as string) ?? null,
    guestId: (row.guest_id as string) ?? null,
    progress: row.progress as number,
    downloadedBytes: Number(row.downloaded_bytes),
    totalBytes: row.total_bytes !== null ? Number(row.total_bytes) : null,
    filename: (row.filename as string) ?? null,
    mimeType: (row.mime_type as string) ?? null,
    errorCode: (row.error_code as string) ?? null,
    errorMessage: (row.error_message as string) ?? null,
    tempPath: (row.temp_path as string) ?? null,
    sourceUrl: (row.source_url as string) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
  };
}

export async function createJob(params: {
  platform: string;
  mediaId: string | null;
  canonicalUrl: string;
  requestedFormat: RequestedFormat;
  userId?: string | null;
  guestId?: string | null;
}): Promise<JobRecord> {
  const { rows } = await pool.query(
    `INSERT INTO jobs (platform, media_id, canonical_url, requested_format, user_id, guest_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [params.platform, params.mediaId, params.canonicalUrl, JSON.stringify(params.requestedFormat), params.userId ?? null, params.guestId ?? null],
  );
  const job = rowToJob(rows[0]);
  activeAbortControllers.set(job.id, new AbortController());
  return job;
}

export async function getJob(id: string): Promise<JobRecord> {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  if (!rows[0]) throw new BlazfetchError('JOB_NOT_FOUND', `Job ${id} was not found.`);
  return rowToJob(rows[0]);
}

export function getJobSignal(id: string): AbortSignal {
  const controller = activeAbortControllers.get(id) ?? new AbortController();
  activeAbortControllers.set(id, controller);
  return controller.signal;
}

export async function updateJobStatus(id: string, status: JobStatus, extra: Partial<Record<string, unknown>> = {}): Promise<void> {
  const fields = ['status = $2', 'updated_at = now()'];
  const values: unknown[] = [id, status];
  let idx = 3;
  for (const [key, value] of Object.entries(extra)) {
    fields.push(`${key} = $${idx}`);
    values.push(value);
    idx += 1;
  }
  await pool.query(`UPDATE jobs SET ${fields.join(', ')} WHERE id = $1`, values);
}

export async function updateJobProgress(id: string, downloadedBytes: number, totalBytes?: number, percent?: number): Promise<void> {
  await pool.query(
    `UPDATE jobs SET downloaded_bytes = $2, total_bytes = COALESCE($3, total_bytes), progress = COALESCE($4, progress), updated_at = now() WHERE id = $1`,
    [id, downloadedBytes, totalBytes ?? null, percent !== undefined ? Math.round(percent) : null],
  );
}

export async function cancelJob(id: string): Promise<void> {
  const controller = activeAbortControllers.get(id);
  controller?.abort();
  await updateJobStatus(id, 'cancelled');
}

export function clearJobController(id: string): void {
  activeAbortControllers.delete(id);
}
