import { BlazfetchResponse } from '../types/blazfetch';
import { JobRecord, JobStatus, RequestedFormat } from '../core/jobs/jobTypes';
import { DownloadStatParams, FetchStatParams } from '../services/statsService';

/**
 * Every database driver (Postgres, MySQL, SQLite, MongoDB) implements this same set of
 * interfaces. The rest of the app talks to `getDb()` only — it never knows or cares which
 * backend is actually storing the data. All four store the exact same three things: metadata
 * cache, jobs, and fetch/download stats — never the downloaded media itself.
 */
export interface MetadataCacheStore {
  get(platform: string, mediaId: string): Promise<BlazfetchResponse | null>;
  getByUrl(platform: string, canonicalUrl: string): Promise<BlazfetchResponse | null>;
  set(platform: string, mediaId: string, canonicalUrl: string, metadata: BlazfetchResponse): Promise<void>;
}

export interface CreateJobParams {
  platform: string;
  mediaId: string | null;
  canonicalUrl: string;
  requestedFormat: RequestedFormat;
  userId?: string | null;
  guestId?: string | null;
}

export interface JobStore {
  create(params: CreateJobParams): Promise<JobRecord>;
  get(id: string): Promise<JobRecord>;
  updateStatus(id: string, status: JobStatus, extra?: Partial<Record<string, unknown>>): Promise<void>;
  updateProgress(id: string, downloadedBytes: number, totalBytes?: number, percent?: number): Promise<void>;
}

export interface StatsStore {
  recordFetchStat(params: FetchStatParams): Promise<void>;
  recordDownloadStat(params: DownloadStatParams): Promise<void>;
}

export interface Database {
  metadataCache: MetadataCacheStore;
  jobs: JobStore;
  stats: StatsStore;
  checkConnection(): Promise<boolean>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}
