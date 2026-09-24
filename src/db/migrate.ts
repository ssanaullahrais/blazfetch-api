import { getDb } from './index';
import { env } from '../config/env';
import { logger } from '../lib/logger';

async function run(): Promise<void> {
  const db = getDb();
  logger.info({ driver: env.DATABASE_DRIVER }, 'running migrations');
  await db.migrate();
  logger.info('migrations complete');
  await db.close();
}

run().catch((err) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
