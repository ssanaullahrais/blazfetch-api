import { getMongoDb } from './mongoClient';
import { env } from '../../config/env';

/** Creates a TTL index, or — since expireAfterSeconds is otherwise fixed at creation time and a second
 * createIndex with a different value throws IndexOptionsConflict — adjusts an existing one in place with
 * collMod when ONLINE_VISITOR_WINDOW_SECONDS has changed since the collection was first set up. */
async function ensureTtlIndex(collectionName: string, field: string, seconds: number): Promise<void> {
  const db = await getMongoDb();
  const collection = db.collection(collectionName);
  const existing = await collection.indexes().catch(() => []);
  const match = existing.find((idx) => idx.key && Object.keys(idx.key).length === 1 && field in idx.key);
  if (!match) {
    await collection.createIndex({ [field]: 1 } as never, { expireAfterSeconds: seconds });
  } else if (match.expireAfterSeconds !== seconds) {
    await db.command({ collMod: collectionName, index: { keyPattern: { [field]: 1 }, expireAfterSeconds: seconds } });
  }
}

/** MongoDB is schemaless, so "migrating" only means creating indexes for the query patterns
 *  the repositories actually use — equivalent in spirit to the SQL drivers' table+index setup. */
export async function runMongoMigrations(): Promise<void> {
  const db = await getMongoDb();

  await db.collection('metadata_cache').createIndex({ platform: 1, mediaId: 1 }, { unique: true });
  await db.collection('metadata_cache').createIndex({ platform: 1, canonicalUrl: 1 });
  await db.collection('metadata_cache').createIndex({ expiresAt: 1 });
  await db.collection('metadata_cache').createIndex({ nextCheckAt: 1 });
  await db.collection('metadata_cache').createIndex({ platform: 1, kind: 1 });

  await db.collection('jobs').createIndex({ status: 1 });
  await db.collection('jobs').createIndex({ userId: 1 });
  await db.collection('jobs').createIndex({ guestId: 1 });

  await db.collection('fetch_stats').createIndex({ createdAt: 1 });
  await db.collection('fetch_stats').createIndex({ platform: 1 });

  await db.collection('download_stats').createIndex({ createdAt: 1 });

  await db.collection('download_logs').createIndex({ platform: 1, mediaKey: 1, startedAt: -1 });
  await db.collection('download_log_lines').createIndex({ requestId: 1, ts: 1 });

  // TTL index: MongoDB itself removes a presence row this long after its lastSeenAt was last written,
  // which is what recordPresence's upsert refreshes on every heartbeat — the row only actually expires
  // once a visitor stops sending them. Pure housekeeping (like SQL's prunePresence): totals() still filters
  // by the same window explicitly, since the TTL background sweep only runs about once a minute.
  await ensureTtlIndex('visitor_presence', 'lastSeenAt', env.ONLINE_VISITOR_WINDOW_SECONDS);
}
