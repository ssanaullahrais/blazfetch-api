import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { BlazfetchError } from '../../constants/errors';
import { DownloadProgress } from '../adapters/types';
import { classifyYtdlpFailure } from './ytdlpRunner';
import { killProcessTree, processGroupOptions } from '../processTree';

export interface YtdlpDownloadOptions {
  url: string;
  formatId: string;
  outputDir: string;
  signal: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  timeoutMs?: number;
}

const PROGRESS_RE =
  /\[download\]\s+(\d{1,3}(?:\.\d)?)%\s+of\s+~?([\d.]+)(KiB|MiB|GiB)(?:\s+at\s+([\d.]+)(KiB|MiB|GiB)\/s)?(?:\s+ETA\s+(\d{2}:\d{2}(?::\d{2})?))/;

function toBytes(value: string, unit: string): number {
  const n = parseFloat(value);
  switch (unit) {
    case 'KiB':
      return n * 1024;
    case 'MiB':
      return n * 1024 * 1024;
    case 'GiB':
      return n * 1024 * 1024 * 1024;
    default:
      return n;
  }
}

function etaToSeconds(eta: string): number {
  const parts = eta.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/** Prefers ffmpeg for HLS assembly (more reliable on most sites), but some hosts (e.g. Loom's
 *  signed playlists) make ffmpeg fail to open the stream while yt-dlp's native downloader works,
 *  so retry once without it when ffmpeg is what failed. */
export async function downloadWithYtdlp(options: YtdlpDownloadOptions): Promise<string> {
  const state = { ffmpegFailed: false };
  try {
    return await runYtdlpDownload(options, true, state);
  } catch (err) {
    if (!state.ffmpegFailed || options.signal.aborted) throw err;
    logger.warn({ url: options.url }, 'ffmpeg HLS download failed, retrying with the native downloader');
    return runYtdlpDownload(options, false, state);
  }
}

async function runYtdlpDownload(options: YtdlpDownloadOptions, preferFfmpegHls: boolean, state: { ffmpegFailed: boolean }): Promise<string> {
  const { url, formatId, outputDir, signal, onProgress, timeoutMs = env.DOWNLOAD_TOTAL_TIMEOUT_MS } = options;

  await fs.promises.mkdir(outputDir, { recursive: true });
  const outputTemplate = path.join(outputDir, '%(id)s.%(ext)s');

  const args = [
    '-f', formatId,
    '-o', outputTemplate,
    '--no-playlist',
    '--newline',
    '--no-warnings',
    // Forces ffmpeg to assemble HLS/DASH fragments (rather than yt-dlp's native downloader,
    // which can leave a file that "completes" while missing fragments) and remuxes merged
    // video+audio into MP4 so the output container matches what we validate afterward.
    ...(preferFfmpegHls ? ['--hls-prefer-ffmpeg'] : []),
    '--merge-output-format', 'mp4',
    '--print', 'after_move:filepath',
    url,
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(env.YTDLP_PATH, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...processGroupOptions });

    let stderr = '';
    let finalPath = '';
    let settled = false;
    let stopReason: BlazfetchError | undefined;

    // Kill yt-dlp AND whatever it spawned (ffmpeg), and only report back once they are really gone so
    // the caller's temp-file cleanup doesn't race a process that is still writing.
    const stop = (reason: BlazfetchError): void => {
      if (settled || stopReason) return;
      stopReason = reason;
      clearTimeout(timer);
      killProcessTree(child);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(reason);
      }, 3000).unref();
    };

    const timer = setTimeout(() => stop(new BlazfetchError('PROCESS_TIMEOUT', 'Download timed out.')), timeoutMs);

    const onAbort = () => stop(new BlazfetchError('DOWNLOAD_FAILED', 'Request was cancelled.'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = line.match(PROGRESS_RE);
        if (match && onProgress) {
          const [, percent, totalVal, totalUnit, speedVal, speedUnit, eta] = match;
          const totalBytes = toBytes(totalVal, totalUnit);
          onProgress({
            downloadedBytes: Math.round((parseFloat(percent) / 100) * totalBytes),
            totalBytes,
            percent: parseFloat(percent),
            speedBytesPerSec: speedVal && speedUnit ? toBytes(speedVal, speedUnit) : undefined,
            etaSeconds: eta ? etaToSeconds(eta) : undefined,
          });
        } else if (line.trim() && !line.startsWith('[')) {
          finalPath = line.trim();
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BlazfetchError('DOWNLOAD_FAILED', `Failed to launch yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (stopReason) {
        reject(stopReason);
      } else if (code === 0 && finalPath) {
        resolve(finalPath);
      } else {
        state.ffmpegFailed = /ffmpeg exited with code/.test(stderr);
        logger.warn({ code, stderr: stderr.slice(-2000) }, 'yt-dlp download failed');
        reject(classifyYtdlpFailure(stderr));
      }
    });
  });
}
