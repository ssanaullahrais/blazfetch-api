import { getMongoDb } from './mongoClient';

/** MongoDB is schemaless, so "migrating" only means creating indexes for the query patterns
 *  the repositories actually use — equivalent in spirit to the SQL drivers' table+index setup. */
export async function runMongoMigrations(): Promise<void> {
  const db = await getMongoDb();

  await db.collection('metadata_cache').createIndex({ platform: 1, mediaId: 1 }, { unique: true });
  await db.collection('metadata_cache').createIndex({ platform: 1, canonicalUrl: 1 });
  await db.collection('metadata_cache').createIndex({ expiresAt: 1 });

  await db.collection('jobs').createIndex({ status: 1 });
  await db.collection('jobs').createIndex({ userId: 1 });
  await db.collection('jobs').createIndex({ guestId: 1 });

  await db.collection('fetch_stats').createIndex({ createdAt: 1 });
  await db.collection('fetch_stats').createIndex({ platform: 1 });

  await db.collection('download_stats').createIndex({ createdAt: 1 });
}
