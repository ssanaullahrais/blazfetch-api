import { env } from './config/env';
import { logger } from './lib/logger';
import { createApp } from './app';
import { pool, checkDatabaseConnection } from './db/pool';
import { checkFfmpeg, checkFfprobe, checkYtdlp } from './lib/dependencyCheck';
import { cleanupAbandonedTempDirs } from './core/jobs/tempFiles';

async function verifyStartupDependencies(): Promise<void> {
  const [database, ytdlp, ffmpeg, ffprobe] = await Promise.all([
    checkDatabaseConnection(),
    checkYtdlp(),
    checkFfmpeg(),
    checkFfprobe(),
  ]);

  const failures: string[] = [];
  if (!database) failures.push('PostgreSQL connection failed. Check DATABASE_URL.');
  if (!ytdlp.ok) failures.push(`yt-dlp not found or not runnable at "${env.YTDLP_PATH}": ${ytdlp.error}`);
  if (!ffmpeg.ok) failures.push(`ffmpeg not found or not runnable at "${env.FFMPEG_PATH}": ${ffmpeg.error}`);
  if (!ffprobe.ok) failures.push(`ffprobe not found or not runnable at "${env.FFPROBE_PATH}": ${ffprobe.error}`);

  if (failures.length > 0) {
    logger.error({ failures }, 'startup dependency checks failed');
    for (const f of failures) logger.error(f);
    process.exit(1);
  }

  logger.info({ ytdlpVersion: ytdlp.version, ffmpegVersion: ffmpeg.version }, 'startup dependency checks passed');
}

async function main(): Promise<void> {
  await verifyStartupDependencies();
  await cleanupAbandonedTempDirs();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Blazfetch backend listening on port ${env.PORT} (${env.APP_ENV})`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    server.close(() => {
      logger.info('http server closed');
    });

    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
