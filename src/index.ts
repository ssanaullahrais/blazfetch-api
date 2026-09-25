import { env } from './config/env';
import { logger } from './lib/logger';
import { createApp } from './app';
import { getDb } from './db';
import { checkFfmpeg, checkFfprobe, checkYtdlp } from './lib/dependencyCheck';
import { cleanupAbandonedTempDirs, startTempSweeper, sweepTempDir } from './core/jobs/tempFiles';
import { startRevalidationJob } from './core/media/revalidationJob';
import { startPresenceSweeper } from './services/presenceSweepJob';

async function verifyStartupDependencies(): Promise<void> {
  const [database, ytdlp, ffmpeg, ffprobe] = await Promise.all([
    getDb().checkConnection(),
    checkYtdlp(),
    checkFfmpeg(),
    checkFfprobe(),
  ]);

  const failures: string[] = [];
  if (!database) failures.push(`${env.DATABASE_DRIVER} database connection failed. Check DATABASE_URL / DATABASE_SQLITE_PATH.`);
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
  await sweepTempDir();
  const stopSweeper = startTempSweeper();
  const stopRevalidation = startRevalidationJob();
  const stopPresenceSweeper = startPresenceSweeper();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Blazfetch backend listening on port ${env.PORT} (${env.APP_ENV})`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    stopSweeper();
    stopRevalidation();
    stopPresenceSweeper();
    server.close(() => {
      logger.info('http server closed');
    });

    await getDb().close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
