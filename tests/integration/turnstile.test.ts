import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.TURNSTILE_ENABLED = 'true';
  process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
  process.env.RATE_LIMIT_MAX_GUEST = '1000';
});

vi.mock('../../src/services/fetchService', () => ({
  fetchMedia: vi.fn(async () => ({ success: true, platform: 'youtube', mediaType: 'video', mediaId: 'abc', canonicalUrl: 'https://www.youtube.com/watch?v=abc', title: 'T', formats: [], audioFormats: [], extractor: 'yt-dlp' })),
  fetchAudio: vi.fn(async () => ({ success: true, audioFormats: [] })),
}));

import { createApp } from '../../src/app';
import { SITEVERIFY_URL } from '../../src/services/turnstileService';
import { env } from '../../src/config/env';

vi.mock('../../src/services/statsService', () => ({ recordVisitorFetch: vi.fn(async () => undefined) }));

let server: http.Server;
let base: string;
const siteverify = vi.fn();
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  // Only Cloudflare's endpoint is faked; requests to this test server go through.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === SITEVERIFY_URL ? siteverify(input, init) : realFetch(input, init)) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => { siteverify.mockReset(); env.TURNSTILE_ALLOWED_HOSTNAMES = ''; env.TURNSTILE_EXPECTED_ACTION = ''; });

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const cookieOf = (res: Response, name: string): string | undefined => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0];

async function passCheck(): Promise<string> {
  siteverify.mockResolvedValueOnce(json({ success: true }));
  const first = await realFetch(`${base}/config`);
  const guest = cookieOf(first, 'blazfetch_guest_id') as string;
  const res = await realFetch(`${base}/turnstile/verify`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: guest }, body: JSON.stringify({ token: 'XXXX.DUMMY.TOKEN.XXXX' }) });
  expect(res.status).toBe(200);
  return `${guest}; ${cookieOf(res, 'blazfetch_turnstile')}`;
}

describe('Cloudflare Turnstile', () => {
  it('publishes the site key so the frontend needs no configuration of its own', async () => {
    const body = await (await realFetch(`${base}/config`)).json();
    expect(body).toMatchObject({ success: true, turnstile: { enabled: true, siteKey: '1x00000000000000000000AA' } });
    expect(JSON.stringify(body)).not.toContain('1x0000000000000000000000000000000AA'); // never the secret
  });

  it('blocks fetch, stream and download until the check is passed', async () => {
    const fetchRes = await realFetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }) });
    expect(fetchRes.status).toBe(403);
    expect(await fetchRes.json()).toMatchObject({ error: { code: 'TURNSTILE_REQUIRED' } });
    expect((await realFetch(`${base}/stream?url=https://youtu.be/abc&kind=video`)).status).toBe(403);
    expect((await realFetch(`${base}/download`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://youtu.be/abc' }) })).status).toBe(403);
    expect((await realFetch(`${base}/fetch/audio`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://youtu.be/abc' }) })).status).toBe(403);
  });

  it('does not gate GET /media/*: a stored/shared page opens with no pass at all', async () => {
    const res = await realFetch(`${base}/media/youtube/abc`);
    expect(res.status).not.toBe(403);
  });

  it('lets the visitor through after a passed check, using the pass cookie', async () => {
    const cookie = await passCheck();
    expect(siteverify).toHaveBeenCalledTimes(1);
    const sent = (siteverify.mock.calls[0][1] as RequestInit).body as URLSearchParams;
    expect(sent.get('response')).toBe('XXXX.DUMMY.TOKEN.XXXX');
    expect(sent.get('secret')).toBe('1x0000000000000000000000000000000AA');
    const res = await realFetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }) });
    expect(res.status).toBe(200);
  });

  it('does not accept a pass from another visitor', async () => {
    const cookie = await passCheck();
    const stolen = cookie.replace(/blazfetch_guest_id=[^;]+/, 'blazfetch_guest_id=someone-else');
    const res = await realFetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: stolen }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }) });
    expect(res.status).toBe(403);
  });

  it('rejects a token Cloudflare refuses, and does not issue a pass', async () => {
    siteverify.mockResolvedValueOnce(json({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
    const res = await realFetch(`${base}/turnstile/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'bad' }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'TURNSTILE_FAILED' } });
    expect(cookieOf(res, 'blazfetch_turnstile')).toBeUndefined();
  });

  it('fails closed when Cloudflare cannot be reached', async () => {
    siteverify.mockRejectedValueOnce(new Error('network down'));
    const res = await realFetch(`${base}/turnstile/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x' }) });
    expect(res.status).toBe(403);
  });

  it.each([null, { success: 'true' }, { success: true, hostname: 'wrong.example', action: 'download' }, { success: true, hostname: 'allowed.example', action: 'wrong' }])('rejects invalid Siteverify result %j', async (result) => {
    env.TURNSTILE_ALLOWED_HOSTNAMES = 'allowed.example';
    env.TURNSTILE_EXPECTED_ACTION = 'download';
    siteverify.mockResolvedValueOnce(json(result));
    const res = await realFetch(`${base}/turnstile/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test' }) });
    expect(res.status).toBe(403);
    expect(cookieOf(res, 'blazfetch_turnstile')).toBeUndefined();
  });

  it('rejects an unsuccessful HTTP response even if its JSON says success', async () => {
    siteverify.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 503 }));
    const res = await realFetch(`${base}/turnstile/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'test' }) });
    expect(res.status).toBe(403);
  });

  it('treats a malformed pass cookie as a missing pass', async () => {
    const res = await realFetch(`${base}/stream?url=https://youtu.be/abc&kind=video`, { headers: { cookie: 'blazfetch_turnstile=%ZZ' } });
    expect(res.status).toBe(403);
  });
});
