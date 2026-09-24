import { MongoClient, Db } from 'mongodb';
import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getMongoDb(): Promise<Db> {
  if (db) return db;
  if (!env.DATABASE_URL) {
    throw new BlazfetchError('INTERNAL_ERROR', 'DATABASE_URL is required for DATABASE_DRIVER=mongodb.');
  }
  client = new MongoClient(env.DATABASE_URL);
  await client.connect();
  db = client.db();
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
