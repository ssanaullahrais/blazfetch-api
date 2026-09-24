export type JobStatus = 'queued' | 'preparing' | 'ready' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface RequestedFormat {
  formatId: string;
  kind: 'video' | 'audio';
  quality?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  platform: string;
  mediaId: string | null;
  canonicalUrl: string;
  requestedFormat: RequestedFormat;
  userId: string | null;
  guestId: string | null;
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  filename: string | null;
  mimeType: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  tempPath: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}
