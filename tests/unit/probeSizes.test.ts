import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/url', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/url')>('../../src/utils/url');
  return { ...actual, assertUrlIsSafeToFetch: vi.fn(async (raw: string) => new URL(raw)) };
});

import { fillMissingSizes } from '../../src/utils/probeSizes';
import type { BlazfetchResponse } from '../../src/types/blazfetch';

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/broken') { res.statusCode = 403; res.end(); return; }
    res.statusCode = 206;
    res.setHeader('Content-Range', 'bytes 0-0/4443811');
    res.end('x');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('fillMissingSizes', () => {
  it('reads the exact size of plain files listed without one, and leaves the rest alone', async () => {
    const media = {
      formats: [
        { formatId: '1', ext: 'mp4', kind: 'video', url: `${base}/v.mp4` },
        { formatId: 'known', ext: 'mp4', kind: 'video', url: `${base}/k.mp4`, filesizeBytes: 5, filesizeApprox: true },
        { formatId: 'hls-1', ext: 'mp4', kind: 'video', url: `${base}/index.m3u8` },
        { formatId: 'x', ext: 'mp4', kind: 'video', url: `${base}/broken` },
      ],
      audioFormats: [{ formatId: 'a', ext: 'm4a', isConverted: false, url: `${base}/a.m4a` }],
    } as unknown as BlazfetchResponse;
    await fillMissingSizes(media);
    expect(media.formats.map((f) => f.filesizeBytes)).toEqual([4443811, 5, undefined, undefined]);
    expect(media.formats[0].filesizeApprox).toBe(false);
    expect(media.audioFormats[0].filesizeBytes).toBe(4443811);
  });
});
