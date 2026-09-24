import { spawn } from 'node:child_process';
import { env } from '../config/env';

export interface DependencyCheckResult {
  ok: boolean;
  version?: string;
  error?: string;
}

function runVersionCheck(binaryPath: string, args: string[] = ['--version']): Promise<DependencyCheckResult> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, { shell: false, windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'timed out' });
    }, 5000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, version: stdout.trim().split('\n')[0] } : { ok: false, error: `exit code ${code}` });
    });
  });
}

export function checkYtdlp(): Promise<DependencyCheckResult> {
  return runVersionCheck(env.YTDLP_PATH);
}

export function checkFfmpeg(): Promise<DependencyCheckResult> {
  return runVersionCheck(env.FFMPEG_PATH, ['-version']);
}

export function checkFfprobe(): Promise<DependencyCheckResult> {
  return runVersionCheck(env.FFPROBE_PATH, ['-version']);
}

/** Optional — only needed for Instagram profile listing. Not part of startup's fatal checks. */
export function checkInstaloader(): Promise<DependencyCheckResult> {
  return new Promise((resolve) => {
    const child = spawn(env.PYTHON_PATH, ['-c', 'import instaloader; print(instaloader.__version__)'], { shell: false, windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'timed out' });
    }, 5000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, version: stdout.trim() } : { ok: false, error: `python/instaloader not available (exit ${code})` });
    });
  });
}
