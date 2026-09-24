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
}

export async function recordDownloadStat(params: DownloadStatParams): Promise<void> {
  await getDb().stats.recordDownloadStat(params);
}
