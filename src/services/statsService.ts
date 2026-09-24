import { pool } from '../db/pool';

export interface FetchStatParams {
  platform: string;
  mediaId?: string;
  userId?: string | null;
  guestId?: string | null;
  success: boolean;
  extractor?: string;
  fallbackUsed?: string;
  durationMs?: number;
  errorCode?: string;
}

export async function recordFetchStat(params: FetchStatParams): Promise<void> {
  await pool.query(
    `INSERT INTO fetch_stats (platform, media_id, user_id, guest_id, success, extractor, fallback_used, duration_ms, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      params.platform,
      params.mediaId ?? null,
      params.userId ?? null,
      params.guestId ?? null,
      params.success,
      params.extractor ?? null,
      params.fallbackUsed ?? null,
      params.durationMs ?? null,
      params.errorCode ?? null,
    ],
  );
}

export interface DownloadStatParams {
  jobId?: string;
  platform: string;
  mediaId?: string;
  format?: string;
  quality?: string;
  kind: 'video' | 'audio' | 'image';
  userId?: string | null;
  guestId?: string | null;
  success: boolean;
  bytesTransferred?: number;
  processingDurationMs?: number;
  errorCode?: string;
}

export async function recordDownloadStat(params: DownloadStatParams): Promise<void> {
  await pool.query(
    `INSERT INTO download_stats (job_id, platform, media_id, format, quality, kind, user_id, guest_id, success, bytes_transferred, processing_duration_ms, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      params.jobId ?? null,
      params.platform,
      params.mediaId ?? null,
      params.format ?? null,
      params.quality ?? null,
      params.kind,
      params.userId ?? null,
      params.guestId ?? null,
      params.success,
      params.bytesTransferred ?? null,
      params.processingDurationMs ?? null,
      params.errorCode ?? null,
    ],
  );
}
