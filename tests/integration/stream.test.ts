import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blazfetch-stream-'));
process.env.TEMP_DIR = tempDir;
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_MAX_DOWNLOAD = '1000';

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

const children: FakeChild[] = [];
let nextPid = 5000;
/** Test hook: what the next fake yt-dlp/ffmpeg process should do once spawned. */
let behaviour: (child: FakeChild, args: string[]) => void = () => undefined;

// Never signal fake pids: route the tree-kill through the fake child's own kill().
vi.mock('../../src/core/processTree', () => ({
  processGroupOptions: {},
  killProcessTree: (child: { kill: (signal: string) => void }) => child.kill('SIGKILL'),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.pid = nextPid++;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      setImmediate(() => child.emit('close', null));
      return true;
    });
    children.push(child);
    setImmediate(() => behaviour(child, args));
    return child;
  }),
}));

const stats: Record<string, unknown>[] = [];
vi.mock('../../src/services/statsService', () => ({
  recordDownloadStat: vi.fn(async (p: Record<string, unknown>) => {
    stats.push(p);
  }),
  recordFetchStat: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/fetchService', () => ({
  fetchMedia: vi.fn(async () => ({
    success: true,
    platform: 'youtube',
    mediaType: 'video',
    mediaId: 'abc123',
    canonicalUrl: 'https://www.youtube.com/watch?v=abc123',
    title: 'Test Video',
    formats: [
      { formatId: '18', ext: 'mp4', kind: 'video', height: 360 },
      { formatId: '137', ext: 'mp4', kind: 'video_only', height: 1080, requiresMerge: true },
    ],
    audioFormats: [{ formatId: '140', ext: 'm4a', bitrate: 128, isConverted: false }],
    extractor: 'yt-dlp',
  })),
}));

vi.mock('../../src/utils/url', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/url')>('../../src/utils/url');
  return { ...actual, assertUrlIsSafeToFetch: vi.fn(async (raw: string) => new URL(raw)) };
});

import { createApp } from '../../src/app';
import { activeStreamProcessCount } from '../../src/core/ytdlp/ytdlpStream';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  children.length = 0;
  stats.length = 0;
  behaviour = () => undefined;
});

const VIDEO = encodeURIComponent('https://www.youtube.com/watch?v=abc123');

let guestCounter = 0;
function request(pathAndQuery: string, guest = `guest-${guestCounter++}`): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path: pathAndQuery, headers: { cookie: `blazfetch_guest_id=${guest}` }, agent: false }, (res) => resolve({ req, res }));
    req.on('error', reject);
  });
}

async function body(res: http.IncomingMessage): Promise<string> {
  let out = '';
  for await (const chunk of res) out += chunk.toString();
  return out;
}

const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('GET /api/v1/stream', () => {
  it('streams a single-file format with download headers, chunked, and writes nothing to TEMP_DIR', async () => {
    behaviour = (child) => {
      child.stdout.write('hello ');
      setTimeout(() => {
        child.stdout.write('world');
        child.emit('close', 0);
      }, 20);
    };

    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&kind=video`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Test Video.mp4"/);
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['transfer-encoding']).toBe('chunked');
    expect(await body(res)).toBe('hello world');

    expect(fs.readdirSync(tempDir)).toEqual([]);
    await waitFor(() => stats.length === 1);
    expect(stats[0]).toMatchObject({ success: true, platform: 'youtube', kind: 'video', bytesTransferred: 11 });
    await waitFor(() => activeStreamProcessCount() === 0);
  });

  it('resolves formatId=best and honours a custom filename', async () => {
    behaviour = (child, args) => {
      if (args.includes('--dump-single-json')) {
        // yt-dlp resolving the merge: one video URL and one audio URL for ffmpeg to combine.
        child.stdout.write(JSON.stringify({ requested_formats: [{ url: 'https://cdn.example/v.mp4', http_headers: {} }, { url: 'https://cdn.example/a.m4a' }] }));
      } else {
        child.stdout.write('merged-bytes'); // ffmpeg output
      }
      child.emit('close', 0);
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&kind=video&filename=${encodeURIComponent('my clip')}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('filename="my clip.mp4"');
    expect(await body(res)).toBe('merged-bytes');
    // "best" picks the highest resolution (137, video-only), so it is merged through ffmpeg into fragmented MP4.
    const { spawn } = await import('node:child_process');
    const ffmpegCall = vi.mocked(spawn).mock.calls.map((c) => c[1] as string[]).find((a) => a.includes('pipe:1'));
    expect(ffmpegCall?.join(' ')).toContain('frag_keyframe+empty_moov+default_base_moof');
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('returns a JSON error with the right status when yt-dlp fails before the first byte', async () => {
    behaviour = (child) => {
      child.stderr.write('ERROR: This video is private video');
      setTimeout(() => child.emit('close', 1), 10);
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&kind=video`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers['content-type']).toContain('application/json');
    const json = JSON.parse(await body(res));
    expect(json).toMatchObject({ success: false, error: { code: 'PRIVATE_MEDIA' } });
    expect(json.requestId).toBeTruthy();
    await waitFor(() => stats.length === 1);
    expect(stats[0]).toMatchObject({ success: false, errorCode: 'PRIVATE_MEDIA' });
    await waitFor(() => activeStreamProcessCount() === 0);
  });

  it('kills yt-dlp and frees the download slot when the client disconnects mid-stream', async () => {
    behaviour = (child) => {
      child.stdout.write('first-bytes'); // then keep the process running forever
    };
    const guest = 'disconnect-guest';
    const first = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&kind=video`, guest);
    await new Promise<void>((resolve) => first.res.once('data', () => resolve()));
    expect(activeStreamProcessCount()).toBe(1);

    first.req.destroy(); // browser cancelled the download
    first.res.destroy();

    await waitFor(() => children[0].kill.mock.calls.length > 0);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    await waitFor(() => activeStreamProcessCount() === 0);
    await waitFor(() => stats.length === 1);
    expect(stats[0]).toMatchObject({ success: false, errorCode: 'CLIENT_DISCONNECTED' });
    expect(fs.readdirSync(tempDir)).toEqual([]);

    // Same guest has a per-guest limit of 1: this only succeeds if the slot was released.
    behaviour = (child) => {
      child.stdout.write('again');
      child.emit('close', 0);
    };
    const second = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&kind=video`, guest);
    expect(second.res.statusCode).toBe(200);
    expect(await body(second.res)).toBe('again');
  });

  it('aborts the connection (no JSON) when the source fails after the first byte', async () => {
    behaviour = (child) => {
      child.stdout.write('partial');
      setTimeout(() => {
        child.stderr.write('ERROR: network died');
        child.emit('close', 1);
      }, 30);
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&kind=video`);
    expect(res.statusCode).toBe(200);
    await expect(body(res)).rejects.toThrow();
    await waitFor(() => stats.length === 1);
    expect(stats[0]).toMatchObject({ success: false });
    await waitFor(() => activeStreamProcessCount() === 0);
  });

  it('rejects a missing url with VALIDATION_ERROR', async () => {
    const { res } = await request('/api/v1/stream?formatId=18');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(await body(res)).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unsupported or private URL before spawning anything', async () => {
    const { res } = await request(`/api/v1/stream?url=${encodeURIComponent('http://127.0.0.1:8080/secret')}`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(await body(res)).success).toBe(false);
    expect(children).toHaveLength(0);
  });

  it('is not registered when STREAM_MODE_ENABLED=false', async () => {
    vi.resetModules();
    process.env.STREAM_MODE_ENABLED = 'false';
    const { createApp: createDisabledApp } = await import('../../src/app');
    const disabled = createDisabledApp().listen(0);
    await new Promise<void>((resolve) => disabled.once('listening', resolve));
    const disabledPort = (disabled.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve) => http.get({ port: disabledPort, path: `/api/v1/stream?url=${VIDEO}`, agent: false }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }));
    await new Promise<void>((resolve) => disabled.close(() => resolve()));
    delete process.env.STREAM_MODE_ENABLED;
    expect(status).toBe(404);
  });
});
