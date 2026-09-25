import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted runs before the imports below are evaluated, so the app's config really sees these values.
const tempDir = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'blazfetch-stream-'));
  process.env.TEMP_DIR = dir;
  process.env.LOG_LEVEL = 'silent';
  process.env.RATE_LIMIT_MAX_DOWNLOAD = '1000';
  return dir;
});

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
      { formatId: '22', ext: 'mp4', kind: 'video', height: 720, filesizeBytes: 11 },
    ],
    audioFormats: [{ formatId: '140', ext: 'm4a', bitrate: 128, isConverted: false }],
    extractor: 'yt-dlp',
  })),
}));

/** Test hook: what the fake prepare pipeline (POST /download's job runner) does. */
let prepareBehaviour: (jobId: string) => Promise<void> = async () => undefined;
const preparedJobs: string[] = [];
const prepareOptions: Record<string, unknown>[] = [];
const cancelledJobs: string[] = [];

vi.mock('../../src/services/downloadService', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/downloadService')>('../../src/services/downloadService');
  return {
    ...actual,
    startDownloadJob: vi.fn(async (params: { url: string }) => ({ id: `job-${preparedJobs.length + 1}`, platform: 'youtube', canonicalUrl: params.url })),
    runDownloadJob: vi.fn(async (job: { id: string }, _requestId: string, options: Record<string, unknown> = {}) => {
      preparedJobs.push(job.id);
      prepareOptions.push(options);
      await prepareBehaviour(job.id);
      const dir = path.join(tempDir, job.id);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'out.mp4');
      fs.writeFileSync(filePath, 'prepared-bytes');
      return { filePath, filename: 'out.mp4', mimeType: 'video/mp4', bytes: 14, job };
    }),
  };
});

vi.mock('../../src/core/jobs/jobManager', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/jobs/jobManager')>('../../src/core/jobs/jobManager');
  return { ...actual, cancelJob: vi.fn(async (id: string) => void cancelledJobs.push(id)) };
});

vi.mock('../../src/utils/url', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/url')>('../../src/utils/url');
  return { ...actual, assertUrlIsSafeToFetch: vi.fn(async (raw: string) => new URL(raw)) };
});

import { createApp } from '../../src/app';
import { fetchMedia } from '../../src/services/fetchService';
import { BlazfetchError } from '../../src/constants/errors';
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
  prepareOptions.length = 0;
  behaviour = () => undefined;
  prepareBehaviour = async () => undefined;
  preparedJobs.length = 0;
  cancelledJobs.length = 0;
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

  it('honours a custom filename for a phone-safe MP4', async () => {
    behaviour = (child) => {
      child.stdout.write('file-bytes');
      child.emit('close', 0);
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&kind=video&formatId=18&filename=${encodeURIComponent('my clip')}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('filename="my clip.mp4"');
    expect(await body(res)).toBe('file-bytes');
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('prepares "best" in stream mode too, with fast conversion: a live merge would not play on phones', async () => {
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&kind=video&mode=stream`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-blazfetch-mode']).toBe('prepare');
    expect(await body(res)).toBe('prepared-bytes');
    expect(children).toHaveLength(0); // nothing was live-merged
    expect(prepareOptions.at(-1)).toMatchObject({ fastConvert: true });
    await waitFor(() => stats.length === 1);
    expect(stats[0]).toMatchObject({ success: true, mode: 'prepare' });
    await waitFor(() => fs.readdirSync(tempDir).length === 0);
  });

  it('prepares "best" instead of live-merging it in auto mode (a live merge would not play on phones)', async () => {
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&kind=video&mode=auto`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-blazfetch-mode']).toBe('prepare');
    expect(await body(res)).toBe('prepared-bytes');
    expect(children).toHaveLength(0);
    await waitFor(() => stats.length === 1);
    expect(stats[0]).toMatchObject({ success: true, mode: 'prepare' });
    await waitFor(() => fs.readdirSync(tempDir).length === 0);
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

  it('counts a client that hangs up right after the last byte of a known-size file as a completed download', async () => {
    behaviour = (child) => {
      child.stdout.write('hello world'); // exactly filesizeBytes (11), then the process lingers
    };
    const { req, res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=22&kind=video`);
    expect(res.headers['content-length']).toBe('11');
    let got = 0;
    await new Promise<void>((resolve) =>
      res.on('data', (chunk: Buffer) => {
        got += chunk.length;
        if (got >= 11) resolve();
      }),
    );
    req.destroy(); // like curl/browsers do once Content-Length bytes have arrived

    await waitFor(() => stats.length === 1);
    expect(stats[0]).toMatchObject({ success: true, bytesTransferred: 11 });
    await waitFor(() => activeStreamProcessCount() === 0);
  });

  it('retries once with a freshly extracted link when a fallback provider link is refused (expired)', async () => {
    const upstream = http.createServer((req, res) => {
      if (req.url === '/dead') {
        res.writeHead(403).end('An error occurred (code: 1-4).');
      } else {
        res.writeHead(200, { 'content-type': 'video/mp4' }).end('fresh-bytes');
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const media = (linkPath: string) => ({
      success: true,
      platform: 'youtube',
      mediaType: 'video',
      mediaId: 'abc123',
      canonicalUrl: 'https://www.youtube.com/watch?v=abc123',
      title: 'Test Video',
      formats: [{ formatId: 'btch-mp4', ext: 'mp4', kind: 'video', url: `${base}${linkPath}` }],
      audioFormats: [],
      extractor: 'btch-downloader',
    });
    vi.mocked(fetchMedia).mockResolvedValueOnce(media('/dead') as never).mockResolvedValueOnce(media('/live') as never);

    try {
      const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=btch-mp4&kind=video`);
      expect(res.statusCode).toBe(200);
      expect(await body(res)).toBe('fresh-bytes');
      expect(vi.mocked(fetchMedia).mock.calls.at(-1)?.[0]).toMatchObject({ forceRefresh: true, requireFreshUrls: true });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('sets the start cookie for ?token= only once bytes are flowing, and never on an error', async () => {
    behaviour = (child) => {
      child.stdout.write('data');
      child.emit('close', 0);
    };
    const ok = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&kind=video&token=abcd1234efgh`);
    expect(ok.res.statusCode).toBe(200);
    expect(String(ok.res.headers['set-cookie'])).toMatch(/blazfetch_dl_abcd1234efgh=1/);
    await body(ok.res);

    behaviour = (child) => {
      child.stderr.write('ERROR: This video is private video');
      setTimeout(() => child.emit('close', 1), 10);
    };
    const failed = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&kind=video&token=zzzz9999yyyy`);
    expect(failed.res.statusCode).toBeGreaterThanOrEqual(400);
    expect(String(failed.res.headers['set-cookie'] ?? '')).not.toMatch(/blazfetch_dl_/);
    await body(failed.res);
  });

  it('rejects a malformed token', async () => {
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&token=${encodeURIComponent('bad token!')}`);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(await body(res)).error.code).toBe('VALIDATION_ERROR');
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

describe('delivery modes (?mode= / DEFAULT_DOWNLOAD_MODE)', () => {
  const failingStream = (child: FakeChild): void => {
    child.stderr.write('ERROR: something odd happened');
    setTimeout(() => child.emit('close', 1), 10);
  };

  it('uses stream by default and says so in X-Blazfetch-Mode', async () => {
    behaviour = (child) => {
      child.stdout.write('streamed');
      child.emit('close', 0);
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18`);
    expect(res.headers['x-blazfetch-mode']).toBe('stream');
    expect(await body(res)).toBe('streamed');
    expect(preparedJobs).toHaveLength(0);
  });

  it('mode=prepare builds the file on the server, sends it with its size, and deletes it', async () => {
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&mode=prepare`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-blazfetch-mode']).toBe('prepare');
    expect(res.headers['content-length']).toBe('14');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="Test Video.mp4"/);
    expect(await body(res)).toBe('prepared-bytes');
    await waitFor(() => stats.length === 1);
    expect(stats[0]).toMatchObject({ success: true, mode: 'prepare', bytesTransferred: 14 });
    expect(children).toHaveLength(0); // no direct-stream process was ever started
    await waitFor(() => fs.readdirSync(tempDir).length === 0);
  });

  it('mode=auto streams when streaming works (no fallback)', async () => {
    behaviour = (child) => {
      child.stdout.write('streamed');
      child.emit('close', 0);
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&mode=auto`);
    expect(res.headers['x-blazfetch-mode']).toBe('stream');
    expect(await body(res)).toBe('streamed');
    expect(preparedJobs).toHaveLength(0);
  });

  it('mode=auto falls back to prepare in the same request when streaming fails before the first byte', async () => {
    behaviour = failingStream;
    const guest = 'fallback-guest';
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&mode=auto`, guest);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-blazfetch-mode']).toBe('prepare');
    expect(await body(res)).toBe('prepared-bytes');
    expect(preparedJobs).toHaveLength(1);
    await waitFor(() => fs.readdirSync(tempDir).length === 0);
    await waitFor(() => activeStreamProcessCount() === 0);

    // The failed stream attempt must have released its download slot (per-guest limit is 1).
    behaviour = (child) => {
      child.stdout.write('again');
      child.emit('close', 0);
    };
    const next = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&mode=stream`, guest);
    expect(next.res.statusCode).toBe(200);
    expect(await body(next.res)).toBe('again');
  });

  it('mode=stream prepares a source that cannot be streamed at all (ffmpeg refused by the host)', async () => {
    behaviour = (child, args) => {
      if (args.includes('--dump-single-json')) {
        child.stdout.write(JSON.stringify({ requested_formats: [{ url: 'https://cdn.example/v.mp4' }, { url: 'https://cdn.example/a.m4a' }] }));
        child.emit('close', 0);
        return;
      }
      child.stderr.write('Server returned 403 Forbidden (access denied)');
      setTimeout(() => child.emit('close', 8), 10);
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=137&mode=stream`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-blazfetch-mode']).toBe('prepare');
    expect(await body(res)).toBe('prepared-bytes');
    await waitFor(() => stats.length === 1);
    expect(stats[0]).toMatchObject({ success: true, mode: 'prepare', fellBack: true });
    await waitFor(() => fs.readdirSync(tempDir).length === 0);
  });

  it('mode=stream falls back to prepare like auto when streaming fails before the first byte', async () => {
    behaviour = failingStream;
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&mode=stream`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-blazfetch-mode']).toBe('prepare');
    expect(await body(res)).toBe('prepared-bytes');
    expect(prepareOptions.at(-1)).toMatchObject({ fastConvert: true, fellBack: true });
    await waitFor(() => stats.length === 1);
    await waitFor(() => fs.readdirSync(tempDir).length === 0);
  });

  it('mode=stream does not fall back for errors prepare cannot fix (private video)', async () => {
    behaviour = (child) => {
      child.stderr.write('ERROR: This video is private video');
      setTimeout(() => child.emit('close', 1), 10);
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&mode=stream`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(await body(res)).error.code).toBe('PRIVATE_MEDIA');
    expect(preparedJobs).toHaveLength(0);
    await waitFor(() => stats.length === 1);
  });

  it('mode=auto does not fall back for errors prepare cannot fix (private video)', async () => {
    behaviour = (child) => {
      child.stderr.write('ERROR: This video is private video');
      setTimeout(() => child.emit('close', 1), 10);
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&mode=auto`);
    expect(JSON.parse(await body(res)).error.code).toBe('PRIVATE_MEDIA');
    expect(preparedJobs).toHaveLength(0);
  });

  it('mode=auto returns the prepare error when the fallback fails too', async () => {
    behaviour = failingStream;
    prepareBehaviour = async () => {
      throw new BlazfetchError('DOWNLOAD_FAILED', 'prepare failed too');
    };
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&formatId=18&mode=auto`);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(await body(res)).error.message).toBe('prepare failed too');
    await waitFor(() => activeStreamProcessCount() === 0);
  });

  it('cancels the prepare job and removes its file when the client disconnects while the file is being prepared', async () => {
    let release: () => void = () => undefined;
    prepareBehaviour = () => new Promise<void>((resolve) => (release = resolve));
    const req = http.get({ port, path: `/api/v1/stream?url=${VIDEO}&formatId=18&mode=prepare`, headers: { cookie: 'blazfetch_guest_id=disconnect-prepare' }, agent: false });
    req.on('error', () => undefined);
    await waitFor(() => preparedJobs.length === 1);
    expect(stats).toHaveLength(0); // preparing a file is not a completed download
    req.destroy(); // the browser cancelled while the server was still preparing
    await waitFor(() => cancelledJobs.length === 1);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ success: false });
    expect(cancelledJobs[0]).toBe(preparedJobs[0]);
    release(); // the fake runner now writes its file; the controller must delete it, nobody is listening
    await waitFor(() => fs.readdirSync(tempDir).length === 0);
  });

  it('rejects an unknown mode with VALIDATION_ERROR', async () => {
    const { res } = await request(`/api/v1/stream?url=${VIDEO}&mode=turbo`);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(await body(res)).error.code).toBe('VALIDATION_ERROR');
  });
});
