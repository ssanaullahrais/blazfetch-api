import { BlazfetchError } from '../constants/errors';
import { assertUrlIsSafeToFetch } from './url';

const MAX_REDIRECTS = 4;

/**
 * Like safeFetch, but also returns the URL of the final hop (a manual-redirect Response always reports the URL it
 * was asked for, not where the redirects ended).
 */
export async function safeFetchFollow(rawUrl: string, init: RequestInit = {}): Promise<{ response: Response; url: URL }> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertUrlIsSafeToFetch(current);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, url).toString();
      continue;
    }
    return { response: res, url };
  }
  throw new BlazfetchError('DOWNLOAD_FAILED', 'The source redirected too many times.');
}

/**
 * fetch() that follows redirects itself and checks every hop against the SSRF rules. A plain fetch() would follow a
 * redirect from an allowed host to an internal address (for example 169.254.169.254) without ever checking it.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  return (await safeFetchFollow(rawUrl, init)).response;
}
