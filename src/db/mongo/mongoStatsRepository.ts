import { v4 as uuidv4 } from 'uuid';
import { getMongoDb } from './mongoClient';
import { env } from '../../config/env';
import { DownloadStatParams, FetchStatParams } from '../../services/statsService';
import { StatsStore, StatsTotals } from '../types';

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
      cacheHit: params.cacheHit ?? null,
      cacheStale: params.cacheStale ?? null,
      kind: params.kind ?? null,
      source: params.source ?? 'user',
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
      mode: params.mode ?? null,
      firstByteMs: params.firstByteMs ?? null,
      fellBack: params.fellBack ?? null,
      createdAt: new Date(),
    } as never);
  }

  async totals(): Promise<StatsTotals> {
    const db = await getMongoDb();
    const windowStart = new Date(Date.now() - env.ONLINE_VISITOR_WINDOW_SECONDS * 1000);
    const [fetches, downloads, online, perPlatform] = await Promise.all([
      db.collection('fetch_stats').countDocuments({ success: true, source: { $in: ['user', null] } }),
      db.collection('download_stats').countDocuments({ success: true }),
      db.collection('visitor_presence').countDocuments({ lastSeenAt: { $gte: windowStart } }),
      db.collection('download_stats').aggregate<{ _id: string; n: number }>([{ $match: { success: true } }, { $group: { _id: '$platform', n: { $sum: 1 } } }]).toArray(),
    ]);
    const platforms: Record<string, number> = {};
    for (const row of perPlatform) platforms[row._id] = row.n;
    return { fetches, downloads, platforms, online };
  }

  async recordPresence(visitorId: string): Promise<void> {
    const db = await getMongoDb();
    // Every open tab for the same visitor collapses to one document, same as the SQL upsert.
    await db.collection('visitor_presence').updateOne({ _id: visitorId } as never, { $set: { lastSeenAt: new Date() } }, { upsert: true });
  }

  async prunePresence(olderThanMs: number): Promise<void> {
    const db = await getMongoDb();
    await db.collection('visitor_presence').deleteMany({ lastSeenAt: { $lt: new Date(Date.now() - olderThanMs) } });
  }
}
