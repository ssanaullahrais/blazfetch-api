import { v4 as uuidv4 } from 'uuid';
import { getMongoDb } from './mongoClient';
import { DownloadStatParams, FetchStatParams } from '../../services/statsService';
import { StatsStore } from '../types';

export class MongoStatsRepository implements StatsStore {
  async recordFetchStat(params: FetchStatParams): Promise<void> {
    const db = await getMongoDb();
    await db.collection('fetch_stats').insertOne({
      _id: uuidv4(),
      platform: params.platform,
      mediaId: params.mediaId ?? null,
      userId: params.userId ?? null,
      guestId: params.guestId ?? null,
      success: params.success,
      extractor: params.extractor ?? null,
      fallbackUsed: params.fallbackUsed ?? null,
      durationMs: params.durationMs ?? null,
      errorCode: params.errorCode ?? null,
      createdAt: new Date(),
    } as never);
  }

  async recordDownloadStat(params: DownloadStatParams): Promise<void> {
    const db = await getMongoDb();
    await db.collection('download_stats').insertOne({
      _id: uuidv4(),
      jobId: params.jobId ?? null,
      platform: params.platform,
      mediaId: params.mediaId ?? null,
      format: params.format ?? null,
      quality: params.quality ?? null,
      kind: params.kind,
      userId: params.userId ?? null,
      guestId: params.guestId ?? null,
      success: params.success,
      bytesTransferred: params.bytesTransferred ?? null,
      processingDurationMs: params.processingDurationMs ?? null,
      errorCode: params.errorCode ?? null,
      createdAt: new Date(),
    } as never);
  }
}
