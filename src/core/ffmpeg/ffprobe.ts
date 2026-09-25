import { spawn } from 'node:child_process';
import { lowerPriority } from '../processPriority';
import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';

interface FfprobeStream {
  codec_type: 'video' | 'audio' | 'subtitle' | 'data';
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
}

interface FfprobeFormat {
  duration?: string;
  size?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function runFfprobeJson(filePath: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
    const child = spawn(env.FFPROBE_PATH, args, { shell: false, windowsHide: true });
    lowerPriority(child);

    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new BlazfetchError('PROCESS_TIMEOUT', 'ffprobe validation timed out.'));
    }, 20000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new BlazfetchError('DOWNLOAD_FAILED', `Failed to launch ffprobe: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new BlazfetchError('DOWNLOAD_FAILED', 'ffprobe could not inspect the downloaded file.'));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new BlazfetchError('DOWNLOAD_FAILED', 'ffprobe returned unparseable output.'));
      }
    });
  });
}

export interface MediaValidationResult {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/**
 * A completed yt-dlp/ffmpeg process is not the same guarantee as a playable file: fragmented
 * downloads can finish "successfully" while missing frames, and bad merges can produce a
 * black/audio-only result. This inspects the actual streams with ffprobe so we never mark a
 * job completed on file existence alone.
 */
export async function validateMediaFile(
  filePath: string,
  expectedKind: 'video' | 'audio',
): Promise<MediaValidationResult> {
  const fs = await import('node:fs');
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new BlazfetchError('DOWNLOAD_FAILED', 'Downloaded file is empty or missing.');
  }

  const probe = await runFfprobeJson(filePath);
  const streams = probe.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const duration = probe.format?.duration ? parseFloat(probe.format.duration) : undefined;

  if (expectedKind === 'video') {
    if (!videoStream) {
      throw new BlazfetchError('DOWNLOAD_FAILED', 'Downloaded video has no playable video stream (likely a broken/partial download).');
    }
    if (!videoStream.width || !videoStream.height || videoStream.width <= 0 || videoStream.height <= 0) {
      throw new BlazfetchError('DOWNLOAD_FAILED', 'Downloaded video has invalid dimensions.');
    }
    if (!audioStream) {
      // Intentionally video-only formats (e.g. muted clips) exist, but most requests expect
      // audio, so this is logged rather than treated as fatal by the caller.
    }
  } else {
    if (!audioStream) {
      throw new BlazfetchError('DOWNLOAD_FAILED', 'Downloaded audio has no playable audio stream.');
    }
  }

  if (!duration || duration <= 0) {
    throw new BlazfetchError('DOWNLOAD_FAILED', 'Downloaded media has an invalid or zero duration.');
  }

  return {
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    width: videoStream?.width,
    height: videoStream?.height,
    durationSeconds: duration,
  };
}

export const COMPATIBLE_VIDEO_CODECS = new Set(['h264', 'avc1']);
export const COMPATIBLE_AUDIO_CODECS = new Set(['aac', 'mp4a']);

export function isBrowserCompatibleMp4(result: MediaValidationResult): boolean {
  const videoOk = !result.hasVideo || COMPATIBLE_VIDEO_CODECS.has((result.videoCodec ?? '').toLowerCase());
  const audioOk = !result.hasAudio || COMPATIBLE_AUDIO_CODECS.has((result.audioCodec ?? '').toLowerCase());
  return videoOk && audioOk;
}
