import { getDb } from '../db';

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
  /** Answered from the stored media without extracting. */
  cacheHit?: boolean;
  /** A stored answer whose direct media URLs were past their trust window. */
  cacheStale?: boolean;
  kind?: 'video' | 'playlist';
  /** 'user' for a request, 'revalidation' for the weekly existence check, 'internal' for a lookup made on the way to
   *  a download (the visitor's own fetch was already counted). Only 'user' counts toward the public totals. */
  source?: 'user' | 'revalidation' | 'internal';
}

export async function recordFetchStat(params: FetchStatParams): Promise<void> {
  await getDb().stats.recordFetchStat(params);
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
  /** How the file was delivered (GET /stream modes, or 'prepare' for POST /download jobs). */
  mode?: 'stream' | 'prepare';
  firstByteMs?: number;
  /** True when mode=auto had to fall back from stream to prepare. */
  fellBack?: boolean;
}

export async function recordDownloadStat(params: DownloadStatParams): Promise<void> {
  await getDb().stats.recordDownloadStat(params);
  // Successful downloads also count against the stored media itself (mediaId is its storage key).
  if (params.success && params.mediaId && params.mode && params.kind !== 'image') {
    await getDb().metadataCache.recordDownload(params.platform, params.mediaId, { mode: params.mode, bytes: params.bytesTransferred ?? 0 });
  }
}
