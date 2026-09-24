import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentHeader } from '../../src/utils/contentDisposition';
import { assertNotPrivateHost } from '../../src/utils/ssrf';
import { safeFetch } from '../../src/utils/safeFetch';
import { assertOwnership } from '../../src/core/jobs/ownership';

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

  it('allows a public address', async () => {
    await expect(assertNotPrivateHost('93.184.216.34')).resolves.toBeUndefined();
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
