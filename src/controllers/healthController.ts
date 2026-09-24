import { Request, Response } from 'express';
import { getDb } from '../db';
import { logger } from '../lib/logger';
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

  // Versions and the database type are deliberately not returned: this route is public. `npm run diagnostics` shows them.
  if (!ready) logger.warn({ database, ytdlp: ytdlp.ok, ffmpeg: ffmpeg.ok }, 'readiness check failed');

  res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'ready' : 'not_ready',
    checks: {
      database,
      ytdlp: ytdlp.ok,
      ffmpeg: ffmpeg.ok,
    },
  });
}
