import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.RATE_LIMIT_MAX_GUEST = '3';
  process.env.RATE_LIMIT_IP_MULTIPLIER = '2';
});

vi.mock('../../src/services/fetchService', () => ({
  fetchMedia: vi.fn(async () => ({ success: true, platform: 'youtube', mediaType: 'video', mediaId: 'abc', canonicalUrl: 'https://www.youtube.com/watch?v=abc', title: 'T', formats: [], audioFormats: [], extractor: 'yt-dlp' })),
  fetchAudio: vi.fn(async () => ({ success: true, audioFormats: [] })),
}));
vi.mock('../../src/services/statsService', () => ({ recordVisitorFetch: vi.fn(async () => undefined) }));

const { createApp } = await import('../../src/app');

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function fetchAs(cookie?: string, extra: Record<string, string> = {}): Promise<{ status: number; cookie?: string }> {
  const res = await fetch(`${base}/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
  });
  await res.text();
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

describe('rate limits', () => {
  it('limits each visitor separately, and caps an IP that keeps dropping its cookie', async () => {
    // Visitor A uses its own limit of 3 on this IP.
    const first = await fetchAs();
    const a = first.cookie as string;
    expect(first.status).toBe(200);
    expect((await fetchAs(a)).status).toBe(200);
    expect((await fetchAs(a)).status).toBe(200);
    expect((await fetchAs(a)).status).toBe(429);

    // Visitor B on the same IP is not affected by A's limit...
    const b = await fetchAs();
    expect(b.status).toBe(200);
    expect((await fetchAs(b.cookie)).status).toBe(200);
    // ...but the IP as a whole stops at 3 x 2 = 6 successful requests (5 so far), even for a client that sends no
    // cookie at all and so arrives as a brand-new visitor every time.
    expect((await fetchAs()).status).toBe(200);
    expect((await fetchAs()).status).toBe(429);
    expect((await fetchAs()).status).toBe(429);
  });

  it('never applies the IP ceiling to the proxy address when TRUST_PROXY is not set', async () => {
    // Behind an untrusted proxy every visitor would share one address; only the per-visitor limit applies there.
    for (let i = 0; i < 5; i += 1) {
      expect((await fetchAs(undefined, { 'x-forwarded-for': `198.51.100.${i}` })).status).toBe(200);
    }
  });
});
