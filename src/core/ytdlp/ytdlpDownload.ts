import { spawn } from 'node:child_process';
import { lowerPriority } from '../processPriority';
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
  /** Rough size of the finished download, for progress when yt-dlp reports none (ffmpeg-assembled HLS). */
  expectedBytes?: number;
  timeoutMs?: number;
}

/** Marks yt-dlp's machine-readable progress lines on stdout (see PROGRESS_TEMPLATE). */
const PROGRESS_PREFIX = 'BFPROG';
/** One line per progress update: downloaded bytes, exact total, estimated total, and which format is downloading. */
const PROGRESS_TEMPLATE = `download:${PROGRESS_PREFIX} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.format_id)s`;

export interface ProgressSample {
  downloadedBytes: number;
  totalBytes?: number;
  formatId: string;
}

const positive = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Reads one PROGRESS_TEMPLATE line; yt-dlp prints "NA" for values it doesn't know yet. */
export function parseProgressLine(line: string): ProgressSample | null {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== PROGRESS_PREFIX || parts.length < 5) return null;
  const downloadedBytes = positive(parts[1]) ?? 0;
  return { downloadedBytes, totalBytes: positive(parts[2]) ?? positive(parts[3]), formatId: parts[4] };
}

/**
 * Turns per-part samples into one percentage for the whole download. A merged download fetches the video and then
 * the audio as separate parts, each counting from zero, so finished parts are carried over and the result never goes
 * backwards. It stays below 100 until yt-dlp has actually finished.
 */
export class ProgressTracker {
  private readonly finished = new Map<string, number>();
  private current?: ProgressSample;
  private last = 0;

  constructor(private readonly expectedBytes?: number) {}

  update(sample: ProgressSample): number {
    if (this.current && this.current.formatId !== sample.formatId) {
      this.finished.set(this.current.formatId, this.current.totalBytes ?? this.current.downloadedBytes);
    }
    this.current = sample;
    const done = [...this.finished.values()].reduce((sum, n) => sum + n, 0);
    const partTotal = sample.totalBytes ?? Math.max(sample.downloadedBytes, (this.expectedBytes ?? 0) - done);
    const total = Math.max(done + partTotal, this.expectedBytes ?? 0);
    return this.report(total > 0 ? ((done + sample.downloadedBytes) / total) * 100 : 0);
  }

  /** For downloaders that print no progress (ffmpeg assembling HLS): bytes on disk against the expected size. */
  updateFromDisk(bytesOnDisk: number): number | undefined {
    if (!this.expectedBytes) return undefined;
    return this.report((bytesOnDisk / this.expectedBytes) * 100);
  }

  get bytes(): number {
    return [...this.finished.values()].reduce((sum, n) => sum + n, 0) + (this.current?.downloadedBytes ?? 0);
  }

  private report(percent: number): number {
    this.last = Math.max(this.last, Math.min(99, Math.round(percent * 10) / 10));
    return this.last;
  }
}

async function directorySize(dir: string): Promise<number> {
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  let total = 0;
  for (const name of names) {
    const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
    if (stat?.isFile()) total += stat.size;
  }
  return total;
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
  const { url, formatId, outputDir, signal, onProgress, expectedBytes, timeoutMs = env.DOWNLOAD_TOTAL_TIMEOUT_MS } = options;

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
    // --print makes yt-dlp quiet, which also silences progress: bring it back in a form that is easy to parse.
    '--progress',
    '--progress-template', PROGRESS_TEMPLATE,
    url,
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(env.YTDLP_PATH, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...processGroupOptions });
    lowerPriority(child);

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

    const tracker = new ProgressTracker(expectedBytes);
    let lastReportAt = 0;
    const report = (percent: number | undefined): void => {
      if (percent === undefined || !onProgress) return;
      lastReportAt = Date.now();
      onProgress({ downloadedBytes: tracker.bytes, totalBytes: expectedBytes, percent });
    };
    // ffmpeg assembling HLS prints no progress through yt-dlp: fall back to watching the file grow.
    const diskPoll = onProgress && expectedBytes
      ? setInterval(() => {
          if (Date.now() - lastReportAt < 3000) return;
          void directorySize(outputDir).then((size) => {
            if (Date.now() - lastReportAt >= 3000) report(tracker.updateFromDisk(size));
          });
        }, 1000)
      : undefined;
    diskPoll?.unref();

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n|\r/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const sample = parseProgressLine(line);
        if (sample) report(tracker.update(sample));
        else if (line.trim() && !line.startsWith('[')) finalPath = line.trim();
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      clearInterval(diskPoll);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BlazfetchError('DOWNLOAD_FAILED', `Failed to launch yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      clearInterval(diskPoll);
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
