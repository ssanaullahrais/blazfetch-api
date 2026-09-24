import { getDb } from '../src/db';
import { env } from '../src/config/env';
import { checkFfmpeg, checkFfprobe, checkYtdlp } from '../src/lib/dependencyCheck';

async function main(): Promise<void> {
  const db = getDb();
  const [database, ytdlp, ffmpeg, ffprobe] = await Promise.all([
    db.checkConnection(),
    checkYtdlp(),
    checkFfmpeg(),
    checkFfprobe(),
  ]);

  console.log('Blazfetch diagnostics');
  console.log('----------------------');
  console.log(`Node.js:    ${process.version}`);
  console.log(`Database:   ${env.DATABASE_DRIVER} - ${database ? 'connected' : 'NOT CONNECTED'}`);
  console.log(`yt-dlp:     ${ytdlp.ok ? ytdlp.version : `NOT AVAILABLE (${ytdlp.error})`}`);
  console.log(`ffmpeg:     ${ffmpeg.ok ? ffmpeg.version : `NOT AVAILABLE (${ffmpeg.error})`}`);
  console.log(`ffprobe:    ${ffprobe.ok ? ffprobe.version : `NOT AVAILABLE (${ffprobe.error})`}`);

  await db.close();
  process.exit(database && ytdlp.ok && ffmpeg.ok && ffprobe.ok ? 0 : 1);
}

main();
