import { v4 as uuidv4 } from 'uuid';
import { getMongoDb } from './mongoClient';
import { BlazfetchError } from '../../constants/errors';
import { JobRecord, JobStatus } from '../../core/jobs/jobTypes';
import { CreateJobParams, JobStore } from '../types';

interface JobDoc {
  _id: string;
  status: JobStatus;
  platform: string;
  mediaId: string | null;
  canonicalUrl: string;
  requestedFormat: JobRecord['requestedFormat'];
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
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

function docToJob(doc: JobDoc): JobRecord {
  return {
    id: doc._id,
    status: doc.status,
    platform: doc.platform,
    mediaId: doc.mediaId,
    canonicalUrl: doc.canonicalUrl,
    requestedFormat: doc.requestedFormat,
    userId: doc.userId,
    guestId: doc.guestId,
    progress: doc.progress,
    downloadedBytes: doc.downloadedBytes,
    totalBytes: doc.totalBytes,
    filename: doc.filename,
    mimeType: doc.mimeType,
    errorCode: doc.errorCode,
    errorMessage: doc.errorMessage,
    tempPath: doc.tempPath,
    sourceUrl: doc.sourceUrl,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
  };
}

/** Same snake_case extra-field keys the SQL/legacy callers always used, mapped to this
 *  collection's camelCase document fields. */
const FIELD_MAP: Record<string, string> = {
  media_id: 'mediaId',
  filename: 'filename',
  mime_type: 'mimeType',
  downloaded_bytes: 'downloadedBytes',
  progress: 'progress',
  temp_path: 'tempPath',
  source_url: 'sourceUrl',
  error_code: 'errorCode',
  error_message: 'errorMessage',
};

export class MongoJobRepository implements JobStore {
  async create(params: CreateJobParams): Promise<JobRecord> {
    const db = await getMongoDb();
    const now = new Date();
    const doc: JobDoc = {
      _id: uuidv4(),
      status: 'queued',
      platform: params.platform,
      mediaId: params.mediaId,
      canonicalUrl: params.canonicalUrl,
      requestedFormat: params.requestedFormat,
      userId: params.userId ?? null,
      guestId: params.guestId ?? null,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: null,
      filename: null,
      mimeType: null,
      errorCode: null,
      errorMessage: null,
      tempPath: null,
      sourceUrl: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
    };
    await db.collection<JobDoc>('jobs').insertOne(doc);
    return docToJob(doc);
  }

  async get(id: string): Promise<JobRecord> {
    const db = await getMongoDb();
    const doc = await db.collection<JobDoc>('jobs').findOne({ _id: id });
    if (!doc) throw new BlazfetchError('JOB_NOT_FOUND', `Job ${id} was not found.`);
    return docToJob(doc);
  }

  async updateStatus(id: string, status: JobStatus, extra: Partial<Record<string, unknown>> = {}): Promise<void> {
    const db = await getMongoDb();
    const set: Record<string, unknown> = { status, updatedAt: new Date() };
    for (const [key, value] of Object.entries(extra)) {
      set[FIELD_MAP[key] ?? key] = value;
    }
    await db.collection<JobDoc>('jobs').updateOne({ _id: id }, { $set: set });
  }

  async updateProgress(id: string, downloadedBytes: number, totalBytes?: number, percent?: number): Promise<void> {
    const db = await getMongoDb();
    const set: Record<string, unknown> = { downloadedBytes, updatedAt: new Date() };
    if (totalBytes !== undefined) set.totalBytes = totalBytes;
    if (percent !== undefined) set.progress = Math.round(percent);
    await db.collection<JobDoc>('jobs').updateOne({ _id: id }, { $set: set });
  }
}
