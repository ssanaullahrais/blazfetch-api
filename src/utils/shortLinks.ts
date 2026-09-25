import { env } from '../config/env';
import { BlazfetchError } from '../constants/errors';
import { safeFetchFollow } from './safeFetch';
import { NormalizedUrlResult, validateAndNormalizeUrl } from './url';

/**
 * General-purpose short-link hosts on the platform allowlist. They can point anywhere (including an internal address),
 * and yt-dlp would follow their redirects itself, without the SSRF checks. So they are resolved here first, with every
 * hop checked, and only the final URL is handed on, which must itself be a supported platform.
 *
 * A platform's own short links (redd.it, fb.watch, pin.it, ...) only lead within that platform and are left as they
 * were: yt-dlp (or the Pinterest adapter) understands them natively.
 */
const OPEN_SHORTENERS = new Set(['t.co']);

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { result: NormalizedUrlResult; expiresAt: number }>();
const MAX_HTML_BYTES = 64 * 1024;

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

/** A general-purpose shortener (it can lead anywhere), which must never reach yt-dlp unresolved. */
export function isOpenShortLink(url: string): boolean {
  return OPEN_SHORTENERS.has(hostOf(url));
}

/** t.co answers some clients with a 200 page instead of a redirect; the target is in its meta refresh. */
function metaRefreshTarget(html: string, base: URL): string | undefined {
  const tag = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i)?.[0];
  const target = tag?.match(/content=["']?\s*\d*\s*;?\s*url=([^"'>\s]+)/i)?.[1];
  if (!target) return undefined;
  try {
    return new URL(target.replace(/&amp;/g, '&'), base).toString();
  } catch {
    return undefined;
  }
}

async function follow(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.REDIRECT_RESOLVE_TIMEOUT_MS);
  try {
    let current = url;
    for (let page = 0; page < 3; page += 1) {
      const { response, url: reached } = await safeFetchFollow(current, { signal: controller.signal });
      if (!isOpenShortLink(reached.toString())) {
        await response.body?.cancel().catch(() => undefined);
        return reached.toString();
      }
      const html = (await response.text()).slice(0, MAX_HTML_BYTES);
      const next = metaRefreshTarget(html, reached);
      if (!next) break;
      current = next;
    }
    throw new BlazfetchError('INVALID_URL', 'This short link could not be resolved.');
  } catch (err) {
    if (err instanceof BlazfetchError) throw err;
    throw new BlazfetchError('INVALID_URL', 'This short link could not be resolved.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * validateAndNormalizeUrl, plus: an open short link (t.co) is followed, with the SSRF checks on every hop, and
 * replaced by the normalized form of where it leads, which must itself be a supported platform. Every other link is
 * returned exactly as validateAndNormalizeUrl returns it, without any network request.
 */
export async function normalizeAndResolveUrl(raw: string): Promise<NormalizedUrlResult> {
  const normalized = validateAndNormalizeUrl(raw);
  if (!isOpenShortLink(normalized.canonicalUrl)) return normalized;

  const cached = cache.get(normalized.canonicalUrl);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.result, originalUrl: raw };

  const result = { ...validateAndNormalizeUrl(await follow(normalized.canonicalUrl)), originalUrl: raw };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(normalized.canonicalUrl, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/** For tests. */
export function clearShortLinkCache(): void {
  cache.clear();
}
