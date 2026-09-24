import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blazfetch-sweep-'));
process.env.TEMP_DIR = tempDir;
process.env.LOG_LEVEL = 'silent';

let sweepTempDir: typeof import('../../src/core/jobs/tempFiles').sweepTempDir;
let cleanupJobTempDir: typeof import('../../src/core/jobs/tempFiles').cleanupJobTempDir;

beforeAll(async () => {
  ({ sweepTempDir, cleanupJobTempDir } = await import('../../src/core/jobs/tempFiles'));
});

afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function age(target: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(target, when, when);
}

describe('sweepTempDir', () => {
  it('deletes old files and folders (including leftover *-compatible.mp4) but keeps recent ones', async () => {
    const oldJob = path.join(tempDir, 'old-job');
    fs.mkdirSync(oldJob);
    fs.writeFileSync(path.join(oldJob, 'abc-compatible.mp4'), 'x');
    age(oldJob, 2 * 60 * 60 * 1000);

    const oldFile = path.join(tempDir, 'stray.mp4');
    fs.writeFileSync(oldFile, 'x');
    age(oldFile, 2 * 60 * 60 * 1000);

    const freshJob = path.join(tempDir, 'fresh-job');
    fs.mkdirSync(freshJob);
    fs.writeFileSync(path.join(freshJob, 'video.mp4'), 'x');

    const removed = await sweepTempDir(60 * 60 * 1000);

    expect(removed).toBe(2);
    expect(fs.existsSync(oldJob)).toBe(false);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshJob)).toBe(true);
  });

  it('cleanupJobTempDir removes a job folder and everything in it', async () => {
    const dir = path.join(tempDir, 'job-1');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a-compatible.mp4'), 'x');
    await cleanupJobTempDir('job-1');
    expect(fs.existsSync(dir)).toBe(false);
  });
});
