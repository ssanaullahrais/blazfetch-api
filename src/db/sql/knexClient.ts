import path from 'node:path';
import fs from 'node:fs';
import knexFactory, { Knex } from 'knex';
import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';

function buildConfig(): Knex.Config {
  switch (env.DATABASE_DRIVER) {
    case 'postgres':
      if (!env.DATABASE_URL) throw new BlazfetchError('INTERNAL_ERROR', 'DATABASE_URL is required for DATABASE_DRIVER=postgres.');
      return {
        client: 'pg',
        connection: { connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined },
        pool: { min: 0, max: 20 },
      };
    case 'mysql':
      if (!env.DATABASE_URL) throw new BlazfetchError('INTERNAL_ERROR', 'DATABASE_URL is required for DATABASE_DRIVER=mysql.');
      return {
        client: 'mysql2',
        connection: env.DATABASE_URL,
        pool: { min: 0, max: 20 },
      };
    case 'sqlite': {
      const filePath = path.resolve(env.DATABASE_SQLITE_PATH);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      return {
        client: 'better-sqlite3',
        connection: { filename: filePath },
        useNullAsDefault: true,
        // SQLite is a single-file, single-writer database — pooling multiple connections to
        // the same file (Knex's default pool: min 2, max 10) causes real race conditions: a
        // write committed on one connection isn't guaranteed visible to a read on another
        // immediately after, which surfaced as jobs briefly "not found" right after creation.
        // One shared connection avoids that entirely; better-sqlite3 is synchronous anyway, so
        // there's no concurrency benefit to pooling it like a network database.
        pool: { min: 1, max: 1 },
      };
    }
    default:
      throw new BlazfetchError('INTERNAL_ERROR', `knexClient does not handle DATABASE_DRIVER=${env.DATABASE_DRIVER}`);
  }
}

let instance: Knex | null = null;

/** Lazily creates the shared Knex instance for the configured SQL driver (postgres/mysql/sqlite). */
export function getKnex(): Knex {
  if (!instance) {
    instance = knexFactory(buildConfig());
  }
  return instance;
}

export async function closeKnex(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = null;
  }
}
