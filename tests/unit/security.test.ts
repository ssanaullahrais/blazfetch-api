import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { attachmentHeader } from '../../src/utils/contentDisposition';
import { assertNotPrivateHost } from '../../src/utils/ssrf';
import { safeFetch } from '../../src/utils/safeFetch';
import { assertOwnership } from '../../src/core/jobs/ownership';
import { clearShortLinkCache, normalizeAndResolveUrl } from '../../src/utils/shortLinks';
import { networkKey } from '../../src/utils/clientKey';
import { requestId } from '../../src/middleware/requestId';
import { acquireVisitorDownloadSlots } from '../../src/core/jobs/concurrencyLimiter';
import { ffmpegStreamArgs } from '../../src/core/ytdlp/ytdlpStream';
import { env } from '../../src/config/env';

describe('attachmentHeader', () => {
  it('cannot be bent by the file name', () => {
    const header = attachmentHeader('a"b\r\nSet-Cookie: x=1/../é.mp4');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('"')).toHaveLength(3); // only the two quotes we add around the plain name
    expect(header).toContain("filename*=UTF-8''");
  });

  it('falls back to a safe name', () => {
    expect(attachmentHeader('\r\n')).toContain('filename="download"');
  });
});

describe('ssrf', () => {
  it.each(['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.1', '::1', '::', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'localhost'])(
    'blocks %s',
    async (host) => {
      await expect(assertNotPrivateHost(host)).rejects.toThrow();
    },
  );

  it.each([
    '100.64.0.1', // carrier-grade NAT
    '198.18.0.1', // benchmarking
    '192.0.0.1',
    '224.0.0.1', // multicast
    '255.255.255.255',
    '[::1]', // URL.hostname keeps the brackets
    '[::ffff:127.0.0.1]',
    '::127.0.0.1', // IPv4-compatible
    '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    '2001:0::1', // Teredo
    'fec0::1', // site-local
    'ff02::1', // multicast
    'fd00::1',
    'fe80::1%eth0',
    'localhost.',
  ])('blocks %s', async (host) => {
    await expect(assertNotPrivateHost(host)).rejects.toThrow();
  });

  it.each(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '64:ff9b::5db8:d822', '[2606:4700::1111]'])('allows public %s', async (host) => {
    await expect(assertNotPrivateHost(host)).resolves.toBeUndefined();
  });

  it('refuses a public name that resolves to an internal address', async () => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValueOnce([{ address: '10.1.2.3', family: 4 }] as never);
    await expect(assertNotPrivateHost('rebind.example.com')).rejects.toThrow(/private/);
    vi.restoreAllMocks();
  });
});

describe('short links', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    clearShortLinkCache();
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /** The short link redirects once; the page it leads to answers normally. */
  const redirectTo = (location: string) => {
    let calls = 0;
    return vi.fn(async () => (calls++ === 0 ? new Response(null, { status: 301, headers: { location } }) : new Response('page'))) as unknown as typeof fetch;
  };

  it('replaces a t.co link with the platform URL it leads to', async () => {
    globalThis.fetch = redirectTo('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const result = await normalizeAndResolveUrl('https://t.co/abc123');
    expect(result.platform).toBe('youtube');
    expect(result.canonicalUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result.originalUrl).toBe('https://t.co/abc123');
  });

  it('refuses a t.co link that leads to an internal address, without requesting it', async () => {
    globalThis.fetch = redirectTo('http://169.254.169.254/latest/meta-data/');
    await expect(normalizeAndResolveUrl('https://t.co/evil')).rejects.toThrow(/could not be resolved/);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('refuses a t.co link that leads to a site that is not supported', async () => {
    globalThis.fetch = redirectTo('https://attacker.example/video.html');
    await expect(normalizeAndResolveUrl('https://t.co/other')).rejects.toThrow(/not supported/);
  });

  it('refuses a t.co link that does not redirect', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html></html>')) as unknown as typeof fetch;
    await expect(normalizeAndResolveUrl('https://t.co/stuck')).rejects.toThrow(/could not be resolved/);
  });

  it('follows the meta refresh t.co serves to some clients instead of a redirect', async () => {
    const page = '<head><noscript><META http-equiv="refresh" content="0;URL=https://x.com/user/status/123?s=20&amp;t=abc"></noscript></head>';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('t.co') ? new Response(page) : new Response('tweet')) as unknown as typeof fetch;
    const result = await normalizeAndResolveUrl('https://t.co/meta');
    expect(result.platform).toBe('twitter');
    expect(result.canonicalUrl).toBe('https://x.com/user/status/123');
  });

  it('does not touch the network for any other link, platform short links included', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.tiktok.com/@user/video/7300000000000000000',
      'https://vm.tiktok.com/ZMabc123/',
      'https://www.instagram.com/reel/Cabc123/',
      'https://x.com/user/status/123',
      'https://www.facebook.com/watch/?v=123',
      'https://fb.watch/abc123/',
      'https://www.reddit.com/r/videos/comments/abc/title/',
      'https://redd.it/abc',
      'https://pin.it/abc123',
      'https://soundcloud.com/artist/track',
      'https://vimeo.com/123456',
    ]) {
      const result = await normalizeAndResolveUrl(url);
      expect(result.originalUrl).toBe(url);
    }
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

describe('ffmpeg inputs', () => {
  it('only lets ffmpeg open network protocols', () => {
    const args = ffmpegStreamArgs([{ url: 'https://cdn.example/index.m3u8', headers: {} }], 'remux');
    const at = args.indexOf('-protocol_whitelist');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(args.indexOf('-i'));
    expect(args[at + 1]).not.toMatch(/file|concat|subfile/);
  });
});

describe('per-IP ceilings', () => {
  const req = (ip: string, extra: Partial<Request> = {}) => ({ ip, headers: {}, ...extra }) as unknown as Request;

  it('counts guests by IP address, whatever guest id they send', () => {
    expect(networkKey(req('203.0.113.9', { guestId: 'a' }))).toBe(networkKey(req('203.0.113.9', { guestId: 'b' })));
    expect(networkKey(req('::ffff:203.0.113.9'))).toBe(networkKey(req('203.0.113.9')));
  });

  it('counts an IPv6 client by its /64', () => {
    expect(networkKey(req('2001:db8:1:2::1'))).toBe(networkKey(req('2001:db8:1:2:ffff::9')));
    expect(networkKey(req('2001:db8:1:2::1'))).not.toBe(networkKey(req('2001:db8:1:3::1')));
  });

  it('is off when the address is a proxy the app was not told to trust (visitors would share it)', () => {
    expect(networkKey(req('127.0.0.1', { headers: { 'x-forwarded-for': '198.51.100.1' } } as never))).toBeUndefined();
  });

  it('caps downloads per network even when every request brings a new guest id', () => {
    const releases: (() => void)[] = [];
    try {
      for (let i = 0; i < env.MAX_CONCURRENT_DOWNLOADS_PER_IP; i += 1) releases.push(acquireVisitorDownloadSlots({ guestId: `g${i}`, networkKey: 'ip:198.51.100.7' }));
      expect(() => acquireVisitorDownloadSlots({ guestId: 'g-new', networkKey: 'ip:198.51.100.7' })).toThrow(/limit/);
      expect(() => acquireVisitorDownloadSlots({ guestId: 'g-other', networkKey: 'ip:198.51.100.8' })()).not.toThrow();
    } finally {
      releases.forEach((release) => release());
    }
  });
});

describe('requestId middleware', () => {
  const run = (headers: Record<string, string>) => {
    const req = { headers } as unknown as Request;
    const res = { setHeader: vi.fn(), cookie: vi.fn() };
    requestId(req, res as never, () => undefined);
    return req;
  };
  const uuid = '0b0f6b3a-6f7c-4f0e-9d9e-6b1f0c2a3d4e';

  it('reads the guest cookie by its exact name and only when it is a UUID', () => {
    expect(run({ cookie: `blazfetch_guest_id=${uuid}` }).guestId).toBe(uuid);
    expect(run({ cookie: `xblazfetch_guest_id=${uuid}` }).guestId).not.toBe(uuid);
    expect(run({ cookie: `other=blazfetch_guest_id=${uuid}` }).guestId).not.toBe(uuid);
    expect(run({ cookie: 'blazfetch_guest_id=not-a-uuid' }).guestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts only a short, plain X-Request-Id', () => {
    expect(run({ 'x-request-id': 'abc-123' }).requestId).toBe('abc-123');
    expect(run({ 'x-request-id': 'a'.repeat(500) }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run({ 'x-request-id': 'bad value<script>' }).requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('safeFetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('refuses a redirect from a public host to an internal address', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })) as typeof fetch;
    await expect(safeFetch('http://93.184.216.34/file')).rejects.toThrow(/private/i);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1); // the internal address was never requested
  });

  it('follows a redirect to another public host', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return calls.length === 1 ? new Response(null, { status: 301, headers: { location: 'http://93.184.216.35/final' } }) : new Response('ok');
    }) as typeof fetch;
    const res = await safeFetch('http://93.184.216.34/start');
    expect(await res.text()).toBe('ok');
    expect(calls).toEqual(['http://93.184.216.34/start', 'http://93.184.216.35/final']);
  });

  it('gives up after too many redirects', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://93.184.216.34/again' } })) as typeof fetch;
    await expect(safeFetch('http://93.184.216.34/loop')).rejects.toThrow(/redirected too many/);
  });
});

describe('job ownership', () => {
  const job = { id: 'j1', guestId: 'guest-a', userId: undefined } as never;
  const req = (guestId?: string) => ({ guestId, userId: undefined }) as never;

  it('lets the owner through and hides the job from anyone else', () => {
    expect(() => assertOwnership(req('guest-a'), job)).not.toThrow();
    expect(() => assertOwnership(req('guest-b'), job)).toThrow(/not found/);
  });
});
