import { BlazfetchResponse } from '../types/blazfetch';
import { JobRecord, JobStatus, RequestedFormat } from '../core/jobs/jobTypes';
import { DownloadStatParams, FetchStatParams } from '../services/statsService';

/**
 * Every database driver (Postgres, MySQL, SQLite, MongoDB) implements this same set of
 * interfaces. The rest of the app talks to `getDb()` only — it never knows or cares which
 * backend is actually storing the data. All four store the exact same three things: metadata
 * cache, jobs, and fetch/download stats — never the downloaded media itself.
 */
/** Everything we keep about one piece of media (or one playlist). Rows are never deleted. */
export interface MediaCounters {
  /** Live extractions that produced (or refreshed) this row. */
  fetchCount: number;
  /** Fetches answered from the stored row without extracting. */
  hitCount: number;
  /** Reads through GET /api/v1/media/... */
  viewCount: number;
  downloadCount: number;
  streamCount: number;
  prepareCount: number;
  bytesServed: number;
}

export type MediaStatus = 'available' | 'unavailable';

export interface StoredMedia {
  platform: string;
  /** Item id, or `playlist:<id>` for playlists. */
  mediaKey: string;
  kind: 'video' | 'playlist';
  canonicalUrl: string;
  /** The URL the user originally gave us. */
  sourceUrl: string;
  path: string | null;
  metadata: BlazfetchResponse;
  status: MediaStatus;
  unavailableReason: string | null;
  unavailableSince: string | null;
  /** False for anything extracted with the operator's own login (never served publicly). */
  isPublic: boolean;
  checkFailCount: number;
  firstFetchedAt: string;
  lastFetchedAt: string;
  /** When the direct media URLs inside `metadata` stop being trustworthy. */
  urlsExpireAt: string;
  /** Last time the media was confirmed to still exist. */
  validatedAt: string | null;
  lastCheckAt: string | null;
  /** When the next existence check is due (weekly, sooner after a failure). */
  nextCheckAt: string | null;
  lastAccessedAt: string | null;
  lastDownloadedAt: string | null;
  counters: MediaCounters;
}

export interface UpsertMediaInput {
  platform: string;
  mediaKey: string;
  canonicalUrl: string;
  sourceUrl: string;
  path: string | null;
  metadata: BlazfetchResponse;
  isPublic: boolean;
  urlsExpireAt: Date;
  nextCheckAt: Date;
}

export interface CheckFailureInput {
  code: string;
  /** True for "gone" answers (not found / private) as opposed to timeouts and rate limits. */
  permanent: boolean;
  /** Consecutive permanent failures before the media is marked unavailable. */
  threshold: number;
  nextCheckAt: Date;
}

export interface MetadataCacheStore {
  findByKey(platform: string, mediaKey: string): Promise<StoredMedia | null>;
  findByUrl(platform: string, canonicalUrl: string): Promise<StoredMedia | null>;
  /** Insert or refresh. Keeps first_fetched_at and every counter, marks the media available and validated. */
  upsert(input: UpsertMediaInput): Promise<void>;
  recordCheckFailure(platform: string, mediaKey: string, input: CheckFailureInput): Promise<{ status: MediaStatus; checkFailCount: number }>;
  /** Pushes the next check out without changing anything else (e.g. rows we must not re-check). */
  scheduleNextCheck(platform: string, mediaKey: string, nextCheckAt: Date): Promise<void>;
  recordAccess(platform: string, mediaKey: string, type: 'hit' | 'view'): Promise<void>;
  recordDownload(platform: string, mediaKey: string, params: { mode: 'stream' | 'prepare'; bytes: number }): Promise<void>;
  /** Rows whose existence check is due, oldest first. */
  listDue(now: Date, limit: number): Promise<StoredMedia[]>;
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
