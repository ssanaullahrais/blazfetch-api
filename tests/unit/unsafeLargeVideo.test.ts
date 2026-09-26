import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../../src/core/jobs/jobTypes';
import type { DownloadResult } from '../../src/core/adapters/types';

const FFMPEG_INVOKED = 'ffmpeg-invoked';

vi.mock('../../src/core/ffmpeg/ffprobe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/ffmpeg/ffprobe')>();
  return {
    ...actual,
    // Always an incompatible (VP9/Opus) result, so every case below reaches the transcode decision.
    validateMediaFile: vi.fn(async () => ({ hasVideo: true, hasAudio: true, videoCodec: 'vp9', audioCodec: 'opus', durationSeconds: 5 })),
  };
});

vi.mock('../../src/core/ffmpeg/ffmpegRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/ffmpeg/ffmpegRunner')>();
  return { ...actual, runFfmpeg: vi.fn(async () => { throw new Error(FFMPEG_INVOKED); }) };
});

const job = { id: 'job-1', requestedFormat: { kind: 'video', formatId: 'x' } } as JobRecord;
const bigResult: DownloadResult = { filePath: '/fake/big.webm', filename: 'big.mp4', mimeType: 'video/mp4', bytes: 200 * 1024 * 1024 };
const smallResult: DownloadResult = { filePath: '/fake/small.webm', filename: 'small.mp4', mimeType: 'video/mp4', bytes: 10 * 1024 * 1024 };
const signal = new AbortController().signal;

async function importWithEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  const mod = await import('../../src/services/downloadService');
  for (const key of Object.keys(vars)) delete process.env[key];
  return mod;
}

describe('UNSAFE_LARGE_VIDEO_STREAM_ENABLED', () => {
  afterEach(() => {
    delete process.env.UNSAFE_LARGE_VIDEO_STREAM_ENABLED;
    delete process.env.UNSAFE_LARGE_VIDEO_MIN_BYTES;
  });

  it('is off by default: even a big incompatible video still gets transcoded', async () => {
    const { ensureValidAndCompatible } = await importWithEnv({});
    await expect(ensureValidAndCompatible(job, bigResult, signal)).rejects.toThrow(FFMPEG_INVOKED);
  });

  it('once enabled, skips the transcode for a video at or above the size limit', async () => {
    const { ensureValidAndCompatible } = await importWithEnv({ UNSAFE_LARGE_VIDEO_STREAM_ENABLED: 'true', UNSAFE_LARGE_VIDEO_MIN_BYTES: String(100 * 1024 * 1024) });
    await expect(ensureValidAndCompatible(job, bigResult, signal)).resolves.toBe(bigResult);
  });

  it('still transcodes a video under the size limit even when enabled', async () => {
    const { ensureValidAndCompatible } = await importWithEnv({ UNSAFE_LARGE_VIDEO_STREAM_ENABLED: 'true', UNSAFE_LARGE_VIDEO_MIN_BYTES: String(100 * 1024 * 1024) });
    await expect(ensureValidAndCompatible(job, smallResult, signal)).rejects.toThrow(FFMPEG_INVOKED);
  });
});
