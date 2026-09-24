import { spawn } from 'node:child_process';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { BlazfetchError } from '../../constants/errors';

export interface YtdlpRunOptions {
  args: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBufferBytes?: number;
}

export interface YtdlpRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024; // 64MB of stdout is plenty for even large playlists

/**
 * Executes yt-dlp as a child process with an argument array (never a shell string), so no
 * user-controlled value can ever be interpreted as a shell token. Callers must build `args`
 * from validated/allowlisted values only.
 */
export function runYtdlp(options: YtdlpRunOptions): Promise<YtdlpRunResult> {
  const { args, timeoutMs = env.FETCH_TIMEOUT_MS, signal, maxBufferBytes = DEFAULT_MAX_BUFFER } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(env.YTDLP_PATH, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      reject(new BlazfetchError('PROCESS_TIMEOUT', 'yt-dlp process timed out.'));
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      clearTimeout(timer);
      reject(new BlazfetchError('DOWNLOAD_FAILED', 'Request was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new BlazfetchError('EXTRACTOR_FAILED', 'yt-dlp produced an unexpectedly large response.'));
        }
        return;
      }
      stdout += chunk.toString('utf-8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new BlazfetchError('EXTRACTOR_FAILED', `Failed to launch yt-dlp: ${err.message}`));
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      logger.debug({ exitCode, args: args[0] }, 'yt-dlp process closed');
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export function classifyYtdlpFailure(stderr: string): BlazfetchError {
  const lower = stderr.toLowerCase();
  if (lower.includes('private video') || lower.includes('this video is private')) {
    return new BlazfetchError('PRIVATE_MEDIA', 'This media is private.');
  }
  if (lower.includes('drm protected') || lower.includes('drm-protected')) {
    return new BlazfetchError('FORMAT_UNAVAILABLE', 'This media is DRM-protected and cannot be downloaded.');
  }
  if (lower.includes('not a bot')) {
    // YouTube's temporary "sign in to confirm you're not a bot" block on an IP: nothing to do with this
    // particular video, and worth backing off from rather than retrying.
    return new BlazfetchError('LOGIN_REQUIRED', 'This media requires authentication.', { botCheck: true });
  }
  if (lower.includes('login required') || lower.includes('sign in')) {
    return new BlazfetchError('LOGIN_REQUIRED', 'This media requires authentication.');
  }
  if (/\bage\b|age-restricted|age restricted/.test(lower)) {
    return new BlazfetchError('AGE_RESTRICTED', 'This media is age-restricted.');
  }
  if (lower.includes('not available in your country') || /\bgeo/.test(lower)) {
    return new BlazfetchError('GEO_RESTRICTED', 'This media is not available in this region.');
  }
  // Deleted, removed or never-existing media. These are the answers a weekly recheck relies on to
  // notice that something is really gone, so they must be recognised as MEDIA_NOT_FOUND.
  if (
    /http error 404|404: not found|does not exist|no longer available|has been removed|was removed|has been deleted|has been terminated|is unavailable|video unavailable|content is not available|isn.t available|no video could be found/.test(
      lower,
    )
  ) {
    return new BlazfetchError('MEDIA_NOT_FOUND', 'Media could not be found at the given URL.');
  }
  if (lower.includes('unable to download webpage') || lower.includes('429') || /rate.?limit|too many requests/.test(lower)) {
    return new BlazfetchError('PLATFORM_RATE_LIMITED', 'The source platform is rate-limiting requests.');
  }
  if (lower.includes('unsupported url') || lower.includes('no video formats found')) {
    return new BlazfetchError('MEDIA_NOT_FOUND', 'Media could not be found at the given URL.');
  }
  return new BlazfetchError('EXTRACTOR_FAILED', 'The extractor failed to process this media.');
}
