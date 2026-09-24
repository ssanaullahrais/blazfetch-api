import { Request, Response } from 'express';
import { getDb } from '../db';
import { env } from '../config/env';
import { checkYtdlp, checkFfmpeg } from '../lib/dependencyCheck';

export function getHealth(_req: Request, res: Response): void {
  res.json({ success: true, status: 'ok' });
}

export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const [database, ytdlp, ffmpeg] = await Promise.all([
    getDb().checkConnection(),
    checkYtdlp(),
    checkFfmpeg(),
  ]);
  const ready = database && ytdlp.ok && ffmpeg.ok;

  res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'ready' : 'not_ready',
    checks: {
      database,
      databaseDriver: env.DATABASE_DRIVER,
      ytdlp: ytdlp.ok,
      ytdlpVersion: ytdlp.version,
      ffmpeg: ffmpeg.ok,
      ffmpegVersion: ffmpeg.version,
    },
  });
}
