import { spawn } from 'node:child_process';
import path from 'node:path';
import { env } from '../../../config/env';
import { BlazfetchError, ErrorCodeType } from '../../../constants/errors';
import { logger } from '../../../lib/logger';

export interface InstaloaderPost {
  shortcode: string;
  url: string;
  isVideo: boolean;
  videoUrl: string | null;
  displayUrl: string;
  caption: string | null;
  dateUtc: string;
  likes: number;
  commentCount: number;
}

export interface InstaloaderProfileResult {
  username: string;
  fullName?: string;
  biography?: string;
  profilePicUrl?: string;
  followerCount?: number;
  postCount?: number;
  itemCount: number;
  items: InstaloaderPost[];
}

interface BridgeErrorPayload {
  error: string;
  message: string;
}

const BRIDGE_ERROR_TO_BLAZFETCH: Record<string, ErrorCodeType> = {
  NOT_INSTALLED: 'EXTRACTOR_FAILED',
  BAD_ARGS: 'EXTRACTOR_FAILED',
  SESSION_NOT_FOUND: 'LOGIN_REQUIRED',
  SESSION_INVALID: 'LOGIN_REQUIRED',
  MEDIA_NOT_FOUND: 'MEDIA_NOT_FOUND',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
  PRIVATE_MEDIA: 'PRIVATE_MEDIA',
};

const BRIDGE_SCRIPT = path.join(process.cwd(), 'scripts', 'python', 'instaloader_bridge.py');

/**
 * Lists a public or (with a configured session) private-but-authorized Instagram profile's
 * posts via Instaloader's Python API, bridged through a subprocess. Never handles credentials
 * itself — INSTAGRAM_INSTALOADER_SESSION_PATH must point at a session file the operator already
 * created with `instaloader --login <username>` outside this backend.
 */
export function fetchInstagramProfileViaInstaloader(username: string, maxItems: number): Promise<InstaloaderProfileResult> {
  const args = [
    BRIDGE_SCRIPT,
    username,
    String(maxItems),
    env.INSTAGRAM_INSTALOADER_SESSION_USERNAME || '',
    env.INSTAGRAM_INSTALOADER_SESSION_PATH || '',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(env.PYTHON_PATH, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new BlazfetchError('PROCESS_TIMEOUT', 'Instaloader profile listing timed out.'));
    }, env.INSTALOADER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BlazfetchError('EXTRACTOR_FAILED', `Failed to launch Instaloader bridge (is Python + instaloader installed?): ${err.message}`));
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const lastLine = stdout.trim().split('\n').filter(Boolean).at(-1);
      if (!lastLine) {
        logger.warn({ stderr: stderr.slice(-1000) }, 'instaloader bridge produced no output');
        reject(new BlazfetchError('EXTRACTOR_FAILED', 'Instaloader produced no output.'));
        return;
      }

      let parsed: InstaloaderProfileResult | BridgeErrorPayload;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        logger.warn({ stderr: stderr.slice(-1000), stdout: stdout.slice(-500) }, 'instaloader bridge returned unparseable output');
        reject(new BlazfetchError('EXTRACTOR_FAILED', 'Instaloader returned unparseable output.'));
        return;
      }

      if ('error' in parsed) {
        const code = BRIDGE_ERROR_TO_BLAZFETCH[parsed.error] ?? 'EXTRACTOR_FAILED';
        reject(new BlazfetchError(code, parsed.message));
        return;
      }

      resolve(parsed);
    });
  });
}

/** True only when a real session file path AND matching username are both configured. */
export function isInstaloaderConfigured(): boolean {
  return !!(env.INSTAGRAM_INSTALOADER_SESSION_PATH && env.INSTAGRAM_INSTALOADER_SESSION_USERNAME);
}
