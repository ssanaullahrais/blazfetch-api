import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';
import { logger } from '../../lib/logger';
import { classifyYtdlpFailure, runYtdlp } from './ytdlpRunner';
import { killProcessTree, processGroupOptions } from '../processTree';

/**
 * Low-level building blocks for "direct stream" downloads: bytes flow from yt-dlp / ffmpeg
 * straight to the caller without any file ever being written to TEMP_DIR.
 *
 * Every source returned here owns its child processes: killing it (or aborting the signal it
 * was created with) SIGKILLs them, and a non-zero exit destroys the stream with a
 * BlazfetchError so the caller can turn it into a JSON error (before the first byte) or abort
 * the connection (after it).
 */

export interface StreamSource {
  stream: Readable;
  /** Exact size in bytes, when the source reports one (only for untouched pass-through streams). */
  contentLength?: number;
  /** Kills every child process behind this stream. Safe to call more than once. */
  kill(): void;
}

export interface ResolvedInput {
  url: string;
  headers: Record<string, string>;
  vcodec?: string;
  acodec?: string;
  ext?: string;
  protocol?: string;
}

export type FfmpegMode = 'merge' | 'remux' | 'mp3';

const activeChildren = new Set<number>();

/** Number of yt-dlp/ffmpeg child processes currently alive for streams (used by tests and diagnostics). */
export function activeStreamProcessCount(): number {
  return activeChildren.size;
}

const STDERR_TAIL_BYTES = 4000;

function spawnToStream(
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
  classify: (stderr: string) => BlazfetchError,
  label: string,
): StreamSource {
  const out = new PassThrough();
  const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...processGroupOptions });
  if (child.pid !== undefined) activeChildren.add(child.pid);

  let stderr = '';
  let killed = false;

  const kill = (): void => {
    if (killed) return;
    killed = true;
    killProcessTree(child);
  };
  const onAbort = (): void => {
    kill();
    out.destroy(new BlazfetchError('DOWNLOAD_FAILED', 'Request was cancelled.'));
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  child.stdout?.pipe(out, { end: false });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf-8')).slice(-STDERR_TAIL_BYTES);
  });

  child.on('error', (err) => {
    if (child.pid !== undefined) activeChildren.delete(child.pid);
    out.destroy(new BlazfetchError('DOWNLOAD_FAILED', `Failed to launch ${label}: ${err.message}`));
  });

  child.on('close', (code) => {
    if (child.pid !== undefined) activeChildren.delete(child.pid);
    signal?.removeEventListener('abort', onAbort);
    if (killed) return;
    if (code === 0) {
      out.end();
      return;
    }
    logger.warn({ label, code, stderr: stderr.slice(-2000) }, 'stream process exited non-zero');
    out.destroy(classify(stderr));
  });

  return { stream: out, kill };
}

/** yt-dlp writing one already-final file (no merge needed) straight to stdout. */
export function spawnYtdlpToStdout(options: { url: string; formatSelector: string; signal?: AbortSignal }): StreamSource {
  const args = [
    '-f', options.formatSelector,
    '-o', '-',
    '--no-part',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    options.url,
  ];
  return spawnToStream(env.YTDLP_PATH, args, options.signal, classifyYtdlpFailure, 'yt-dlp');
}

/**
 * Asks yt-dlp for the direct media URL(s) (+ the HTTP headers they need) behind a format
 * selector, without downloading anything. A merge selector like `137+bestaudio` yields two
 * inputs (video, audio) which ffmpeg then combines on the fly.
 */
export async function resolveDirectInputs(options: { url: string; formatSelector: string; signal?: AbortSignal }): Promise<ResolvedInput[]> {
  const { stdout, stderr, exitCode } = await runYtdlp({
    args: ['-f', options.formatSelector, '--dump-single-json', '--no-warnings', '--no-playlist', options.url],
    signal: options.signal,
  });
  if (exitCode !== 0) throw classifyYtdlpFailure(stderr);

  let info: { requested_formats?: RawFormat[] } & RawFormat;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new BlazfetchError('EXTRACTOR_FAILED', 'Failed to parse extractor output.');
  }

  const formats = info.requested_formats?.length ? info.requested_formats : [info];
  const inputs = formats
    .filter((f): f is RawFormat & { url: string } => typeof f.url === 'string' && f.url.length > 0)
    .map((f) => ({
      url: f.url,
      headers: f.http_headers ?? {},
      vcodec: f.vcodec,
      acodec: f.acodec,
      ext: f.ext,
      protocol: f.protocol,
    }));

  if (inputs.length === 0) throw new BlazfetchError('FORMAT_UNAVAILABLE', 'No streamable source was found for this format.');
  return inputs;
}

interface RawFormat {
  url?: string;
  http_headers?: Record<string, string>;
  vcodec?: string;
  acodec?: string;
  ext?: string;
  protocol?: string;
}

function headerArg(headers: Record<string, string>): string[] {
  const lines = Object.entries(headers)
    .filter(([key, value]) => /^[A-Za-z0-9-]+$/.test(key) && !/[\r\n]/.test(value))
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join('');
  return lines ? ['-headers', lines] : [];
}

// httpproxy: deployments that route outbound traffic through an HTTP proxy (http_proxy env) need it.
const FFMPEG_NETWORK_PROTOCOLS = 'http,https,tls,tcp,crypto,httpproxy';

export function ffmpegStreamArgs(inputs: ResolvedInput[], mode: FfmpegMode): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts'];
  // Only network protocols: a manifest from the source must not be able to point ffmpeg at file:, concat:, etc.
  for (const input of inputs) args.push('-protocol_whitelist', FFMPEG_NETWORK_PROTOCOLS, ...headerArg(input.headers), '-i', input.url);

  if (mode === 'mp3') {
    args.push('-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1');
    return args;
  }

  if (mode === 'merge' && inputs.length >= 2) {
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-map', '0:v:0?', '-map', '0:a:0?');
  }
  // HLS carries AAC as ADTS frames; the MP4 muxer needs them converted or it aborts mid-stream.
  const isHls = inputs.some((i) => /\.m3u8(\?|$)/i.test(i.url) || i.protocol?.includes('m3u8'));
  if (isHls) args.push('-bsf:a', 'aac_adtstoasc');
  // A plain MP4 keeps its index at the end of the file, which can't be written to a pipe.
  // Fragmented MP4 is self-describing from the first byte, so it streams and plays as it arrives.
  args.push('-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}

/** ffmpeg reading resolved URLs and writing the requested container/codec to stdout. */
export function spawnFfmpegToStdout(options: { inputs: ResolvedInput[]; mode: FfmpegMode; signal?: AbortSignal }): StreamSource {
  const args = ffmpegStreamArgs(options.inputs, options.mode);
  return spawnToStream(
    env.FFMPEG_PATH,
    args,
    options.signal,
    () => new BlazfetchError('DOWNLOAD_FAILED', 'ffmpeg failed to process the stream.'),
    'ffmpeg',
  );
}
