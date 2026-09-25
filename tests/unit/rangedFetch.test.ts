import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The test server lives on 127.0.0.1, which the real SSRF check (rightly) refuses.
vi.mock('../../src/utils/url', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/url')>('../../src/utils/url');
  return { ...actual, assertUrlIsSafeToFetch: vi.fn(async (raw: string) => new URL(raw)) };
});

import { CHUNK_BYTES, openRanged } from '../../src/utils/rangedFetch';
import { relayUrl, relayedUrlCount } from '../../src/core/ytdlp/inputRelay';

const FILE = Buffer.alloc(CHUNK_BYTES * 2 + 12345);
for (let i = 0; i < FILE.length; i += 1) FILE[i] = i % 251;

const requests: string[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(`${req.url} ${req.headers.range ?? ''}`);
    if (req.url === '/no-range') {
      res.setHeader('Content-Length', String(FILE.length));
      res.end(FILE);
      return;
    }
    const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) {
      res.setHeader('Content-Length', String(FILE.length));
      res.end(FILE);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(match[2] ? Number(match[2]) : FILE.length - 1, FILE.length - 1);
    if (start >= FILE.length) {
      res.statusCode = 416;
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${FILE.length}`);
    res.setHeader('Content-Length', String(end - start + 1));
    res.end(FILE.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts);
}

describe('openRanged', () => {
  it('reads a whole file as a series of range requests no larger than CHUNK_BYTES', async () => {
    requests.length = 0;
    const source = await openRanged(`${base}/file`);
    expect(source).toMatchObject({ status: 200, totalBytes: FILE.length, contentLength: FILE.length });
    expect((await readAll(source.stream)).equals(FILE)).toBe(true);
    expect(requests).toEqual([
      `/file bytes=0-${CHUNK_BYTES - 1}`,
      `/file bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`,
      `/file bytes=${CHUNK_BYTES * 2}-${FILE.length - 1}`,
    ]);
  });

  it('reads from an offset to an end', async () => {
    const source = await openRanged(`${base}/file`, { start: 100, end: CHUNK_BYTES + 99 });
    expect(source).toMatchObject({ status: 206, start: 100, end: CHUNK_BYTES + 99, contentLength: CHUNK_BYTES });
    expect((await readAll(source.stream)).equals(FILE.subarray(100, CHUNK_BYTES + 100))).toBe(true);
  });

  it('passes a host that ignores Range straight through', async () => {
    const source = await openRanged(`${base}/no-range`);
    expect(source.status).toBe(200);
    expect((await readAll(source.stream)).equals(FILE)).toBe(true);
  });

  it('refuses an offset on a host that ignores Range', async () => {
    await expect(openRanged(`${base}/no-range`, { start: 10 })).rejects.toThrow(/offset/);
  });
});

describe('input relay', () => {
  it('serves a registered URL (whole, and from a seek offset) and forgets it once released', async () => {
    const relay = await relayUrl(`${base}/file`);
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[a-f0-9]{32}$/);

    const whole = await fetch(relay.url, { headers: { range: 'bytes=0-' } });
    expect(whole.status).toBe(206);
    expect(whole.headers.get('content-range')).toBe(`bytes 0-${FILE.length - 1}/${FILE.length}`);
    expect(Buffer.from(await whole.arrayBuffer()).equals(FILE)).toBe(true);

    const seek = await fetch(relay.url, { headers: { range: `bytes=${FILE.length - 10}-` } });
    expect(seek.status).toBe(206);
    expect(Buffer.from(await seek.arrayBuffer()).equals(FILE.subarray(FILE.length - 10))).toBe(true);

    relay.release();
    expect(relayedUrlCount()).toBe(0);
    expect((await fetch(relay.url)).status).toBe(404);
  });

  it('serves nothing for an unknown token', async () => {
    const relay = await relayUrl(`${base}/file`);
    const other = relay.url.replace(/[a-f0-9]{32}$/, '0'.repeat(32));
    expect((await fetch(other)).status).toBe(404);
    relay.release();
  });
});
