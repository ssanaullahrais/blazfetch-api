import { v4 as uuidv4 } from 'uuid';
import { getKnex } from './knexClient';
import { BlazfetchError } from '../../constants/errors';
import { JobRecord, JobStatus } from '../../core/jobs/jobTypes';
import { CreateJobParams, JobStore } from '../types';

interface JobRow {
  id: string;
  status: JobStatus;
  platform: string;
  media_id: string | null;
  canonical_url: string;
  requested_format: string | JobRecord['requestedFormat'];
  user_id: string | null;
  guest_id: string | null;
  progress: number;
  downloaded_bytes: number | string;
  total_bytes: number | string | null;
  filename: string | null;
  mime_type: string | null;
  error_code: string | null;
  error_message: string | null;
  temp_path: string | null;
  source_url: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

/** SQLite's CURRENT_TIMESTAMP yields a UTC string with no zone ("2026-01-01 12:00:00"), which
 *  `new Date()` would read as server-local time. Mark it as UTC so every driver agrees. */
function toIso(value: Date | string | number): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
    return new Date(value.replace(' ', 'T') + 'Z').toISOString();
  }
  return new Date(value).toISOString();
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    status: row.status,
    platform: row.platform,
    mediaId: row.media_id,
    canonicalUrl: row.canonical_url,
    requestedFormat: parseJson(row.requested_format),
    userId: row.user_id,
    guestId: row.guest_id,
    progress: row.progress,
    downloadedBytes: Number(row.downloaded_bytes),
    totalBytes: row.total_bytes !== null ? Number(row.total_bytes) : null,
    filename: row.filename,
    mimeType: row.mime_type,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    tempPath: row.temp_path,
    sourceUrl: row.source_url,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: row.expires_at ? toIso(row.expires_at) : null,
  };
}

/** Maps the same `snake_case` extra-field keys the Postgres implementation always used
 *  (e.g. `temp_path`, `error_code`) so callers don't need driver-specific field names. */
function camelizeExtra(extra: Partial<Record<string, unknown>>): Record<string, unknown> {
  const map: Record<string, string> = {
    filename: 'filename',
    mime_type: 'mime_type',
    downloaded_bytes: 'downloaded_bytes',
    progress: 'progress',
    temp_path: 'temp_path',
    source_url: 'source_url',
    error_code: 'error_code',
    error_message: 'error_message',
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    out[map[key] ?? key] = value;
  }
  return out;
}

export class SqlJobRepository implements JobStore {
  async create(params: CreateJobParams): Promise<JobRecord> {
    const knex = getKnex();
    const id = uuidv4();
    await knex('jobs').insert({
      id,
      status: 'queued',
      platform: params.platform,
      media_id: params.mediaId,
      canonical_url: params.canonicalUrl,
      requested_format: JSON.stringify(params.requestedFormat),
      user_id: params.userId ?? null,
      guest_id: params.guestId ?? null,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
    return this.get(id);
  }

  async get(id: string): Promise<JobRecord> {
    const row = await getKnex()<JobRow>('jobs').where({ id }).first();
    if (!row) throw new BlazfetchError('JOB_NOT_FOUND', `Job ${id} was not found.`);
    return rowToJob(row);
  }

  async updateStatus(id: string, status: JobStatus, extra: Partial<Record<string, unknown>> = {}): Promise<void> {
    const knex = getKnex();
    await knex('jobs')
      .where({ id })
      .update({ status, updated_at: knex.fn.now(), ...camelizeExtra(extra) });
  }

  async updateProgress(id: string, downloadedBytes: number, totalBytes?: number, percent?: number): Promise<void> {
    const knex = getKnex();
    const update: Record<string, unknown> = { downloaded_bytes: downloadedBytes, updated_at: knex.fn.now() };
    if (totalBytes !== undefined) update.total_bytes = totalBytes;
    if (percent !== undefined) update.progress = Math.round(percent);
    await knex('jobs').where({ id }).update(update);
  }
}
