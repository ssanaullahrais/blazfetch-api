import { checkDatabaseConnection, pool } from '../src/db/pool';
import { checkFfmpeg, checkFfprobe, checkYtdlp } from '../src/lib/dependencyCheck';

async function main(): Promise<void> {
  const [database, ytdlp, ffmpeg, ffprobe] = await Promise.all([
    checkDatabaseConnection(),
    checkYtdlp(),
    checkFfmpeg(),
    checkFfprobe(),
  ]);

  console.log('Blazfetch diagnostics');
  console.log('----------------------');
  console.log(`Node.js:    ${process.version}`);
  console.log(`PostgreSQL: ${database ? 'connected' : 'NOT CONNECTED'}`);
  console.log(`yt-dlp:     ${ytdlp.ok ? ytdlp.version : `NOT AVAILABLE (${ytdlp.error})`}`);
  console.log(`ffmpeg:     ${ffmpeg.ok ? ffmpeg.version : `NOT AVAILABLE (${ffmpeg.error})`}`);
  console.log(`ffprobe:    ${ffprobe.ok ? ffprobe.version : `NOT AVAILABLE (${ffprobe.error})`}`);

  await pool.end();
  process.exit(database && ytdlp.ok && ffmpeg.ok && ffprobe.ok ? 0 : 1);
}

main();
