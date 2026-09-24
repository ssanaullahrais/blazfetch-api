import { spawn } from 'node:child_process';
import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';
import { logger } from '../../lib/logger';

export interface FfmpegRunOptions {
  args: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Runs ffmpeg with an argument array (no shell interpolation of any input path/URL). */
export function runFfmpeg(options: FfmpegRunOptions): Promise<void> {
  const { args, timeoutMs = env.FFMPEG_TIMEOUT_MS, signal } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(env.FFMPEG_PATH, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      reject(new BlazfetchError('PROCESS_TIMEOUT', 'ffmpeg process timed out.'));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      clearTimeout(timer);
      reject(new BlazfetchError('DOWNLOAD_FAILED', 'Request was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BlazfetchError('DOWNLOAD_FAILED', `Failed to launch ffmpeg: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        logger.warn({ code, stderr: stderr.slice(-2000) }, 'ffmpeg exited non-zero');
        reject(new BlazfetchError('DOWNLOAD_FAILED', 'ffmpeg processing failed.'));
      }
    });
  });
}

/**
 * Merges a video-only and audio-only stream into one MP4. `transcodeVideo`/`transcodeAudio`
 * force re-encoding to H.264/AAC when the source codec isn't broadly compatible (VP9, AV1,
 * Opus, etc.) instead of blindly stream-copying into an MP4 container that wouldn't actually
 * play. `-avoid_negative_ts make_zero` and `-fflags +genpts` guard against the black-frame/
 * broken-seek symptoms caused by bad timestamps after merging two independently-fetched streams.
 */
export function mergeVideoAudioArgs(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  options: { transcodeVideo?: boolean; transcodeAudio?: boolean } = {},
): string[] {
  return [
    '-y',
    '-fflags', '+genpts',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', options.transcodeVideo ? 'libx264' : 'copy',
    // yuv420p: 10-bit or 4:4:4 sources otherwise play as a black screen on phones.
    ...(options.transcodeVideo ? ['-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'] : []),
    '-c:a', options.transcodeAudio ? 'aac' : 'copy',
    ...(options.transcodeAudio ? ['-b:a', '192k'] : []),
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    outputPath,
  ];
}

/** Re-encodes an arbitrary video into a browser-safe H.264/AAC MP4 without re-selecting sources. */
export function transcodeToCompatibleMp4Args(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-fflags', '+genpts',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    outputPath,
  ];
}

export function extractAudioArgs(inputPath: string, outputPath: string, bitrateKbps = 192): string[] {
  return ['-y', '-fflags', '+genpts', '-i', inputPath, '-vn', '-b:a', `${bitrateKbps}k`, '-acodec', 'libmp3lame', outputPath];
}
