import { env } from '../config/env';
import { Database } from './types';
import { getKnex, closeKnex } from './sql/knexClient';
import { runSqlMigrations } from './sql/sqlSchema';
import { SqlMetadataCacheRepository } from './sql/sqlMetadataCacheRepository';
import { SqlJobRepository } from './sql/sqlJobRepository';
import { SqlStatsRepository } from './sql/sqlStatsRepository';
import { SqlDownloadLogsRepository } from './sql/sqlDownloadLogsRepository';
import { getMongoDb, closeMongo } from './mongo/mongoClient';
import { runMongoMigrations } from './mongo/mongoSchema';
import { MongoMetadataCacheRepository } from './mongo/mongoMetadataCacheRepository';
import { MongoJobRepository } from './mongo/mongoJobRepository';
import { MongoStatsRepository } from './mongo/mongoStatsRepository';
import { MongoDownloadLogsRepository } from './mongo/mongoDownloadLogsRepository';

let instance: Database | null = null;

function buildSqlDatabase(): Database {
  return {
    metadataCache: new SqlMetadataCacheRepository(),
    jobs: new SqlJobRepository(),
    stats: new SqlStatsRepository(),
    downloadLogs: new SqlDownloadLogsRepository(),
    async checkConnection() {
      try {
        await getKnex().raw('select 1');
        return true;
      } catch {
        return false;
      }
    },
    migrate: runSqlMigrations,
    close: closeKnex,
  };
}

function buildMongoDatabase(): Database {
  return {
    metadataCache: new MongoMetadataCacheRepository(),
    jobs: new MongoJobRepository(),
    stats: new MongoStatsRepository(),
    downloadLogs: new MongoDownloadLogsRepository(),
    async checkConnection() {
      try {
        const db = await getMongoDb();
        await db.command({ ping: 1 });
        return true;
      } catch {
        return false;
      }
    },
    migrate: runMongoMigrations,
    close: closeMongo,
  };
}

/** Single entry point the rest of the app uses for persistence. Picks the implementation based
 *  on DATABASE_DRIVER (postgres/mysql/sqlite all share the SQL implementation via Knex; mongodb
 *  gets its own document-store implementation) and caches it for the process lifetime. */
export function getDb(): Database {
  if (!instance) {
    instance = env.DATABASE_DRIVER === 'mongodb' ? buildMongoDatabase() : buildSqlDatabase();
  }
  return instance;
}
