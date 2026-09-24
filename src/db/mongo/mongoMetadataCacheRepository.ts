import { getMongoDb } from './mongoClient';
import { env } from '../../config/env';
import { BlazfetchResponse } from '../../types/blazfetch';
import { MetadataCacheStore } from '../types';

interface MetadataCacheDoc {
  platform: string;
  mediaId: string;
  canonicalUrl: string;
  metadata: BlazfetchResponse;
  lastFetchedAt: Date;
  expiresAt: Date;
}

export class MongoMetadataCacheRepository implements MetadataCacheStore {
  async get(platform: string, mediaId: string): Promise<BlazfetchResponse | null> {
    const db = await getMongoDb();
    const doc = await db.collection<MetadataCacheDoc>('metadata_cache').findOne({ platform, mediaId });
    if (!doc || doc.expiresAt.getTime() < Date.now()) return null;
    return doc.metadata;
  }

  async getByUrl(platform: string, canonicalUrl: string): Promise<BlazfetchResponse | null> {
    const db = await getMongoDb();
    const doc = await db
      .collection<MetadataCacheDoc>('metadata_cache')
      .findOne({ platform, canonicalUrl }, { sort: { lastFetchedAt: -1 } });
    if (!doc || doc.expiresAt.getTime() < Date.now()) return null;
    return doc.metadata;
  }

  async set(platform: string, mediaId: string, canonicalUrl: string, metadata: BlazfetchResponse): Promise<void> {
    const db = await getMongoDb();
    const expiresAt = new Date(Date.now() + env.CACHE_TTL_SECONDS * 1000);
    await db.collection<MetadataCacheDoc>('metadata_cache').updateOne(
      { platform, mediaId },
      { $set: { platform, mediaId, canonicalUrl, metadata, lastFetchedAt: new Date(), expiresAt } },
      { upsert: true },
    );
  }
}
