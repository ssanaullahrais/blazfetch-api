import { env } from '../config/env';
import { BlazfetchError } from '../constants/errors';
import { safeFetchFollow } from './safeFetch';
import { NormalizedUrlResult, validateAndNormalizeUrl } from './url';

/**
 * Short-link hosts on the platform allowlist. yt-dlp would follow their redirects itself, without the SSRF checks,
 * so they are resolved here first (every hop checked) and only the final, allowlisted URL is handed on.
 * General-purpose shorteners can point anywhere and must resolve to a supported platform; a platform's own short
 * host that answers without a redirect is left for yt-dlp, which understands it natively.
 */
// (fb.me, snd.sc, dai.ly and instagr.am never get here: validateAndNormalizeUrl rewrites them to the main domain.)
const GENERAL_SHORTENERS = new Set(['t.co']);
const PLATFORM_SHORTENERS = new Set(['redd.it', 'fb.watch']);

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { result: NormalizedUrlResult; expiresAt: number }>();

function shortLinkHost(canonicalUrl: string): string | undefined {
  const host = new URL(canonicalUrl).hostname.toLowerCase().replace(/^www\./, '');
  return GENERAL_SHORTENERS.has(host) || PLATFORM_SHORTENERS.has(host) ? host : undefined;
}

export function isShortLink(canonicalUrl: string): boolean {
  return shortLinkHost(canonicalUrl) !== undefined;
}

/** A general-purpose shortener (it can lead anywhere), which must never reach yt-dlp unresolved. */
export function isOpenShortLink(canonicalUrl: string): boolean {
  const host = shortLinkHost(canonicalUrl);
  return host !== undefined && GENERAL_SHORTENERS.has(host);
}

async function follow(url: string): Promise<URL> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.REDIRECT_RESOLVE_TIMEOUT_MS);
  try {
    const { response, url: finalUrl } = await safeFetchFollow(url, { method: 'GET', signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    return finalUrl;
  } catch (err) {
    if (err instanceof BlazfetchError) throw err;
    throw new BlazfetchError('INVALID_URL', 'This short link could not be resolved.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * validateAndNormalizeUrl, plus: a short link is followed (with the SSRF checks on every hop) and replaced by the
 * normalized form of where it leads, which must itself be a supported platform.
 */
export async function normalizeAndResolveUrl(raw: string): Promise<NormalizedUrlResult> {
  const normalized = validateAndNormalizeUrl(raw);
  const host = shortLinkHost(normalized.canonicalUrl);
  if (!host) return normalized;

  const cached = cache.get(normalized.canonicalUrl);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.result, originalUrl: raw };

  const finalUrl = await follow(normalized.canonicalUrl);
  let result: NormalizedUrlResult;
  if (isShortLink(finalUrl.toString())) {
    // No redirect (or one short link pointing at another): only a platform's own short host may go on as it is.
    if (!PLATFORM_SHORTENERS.has(host) || finalUrl.hostname.replace(/^www\./, '') !== host) {
      throw new BlazfetchError('INVALID_URL', 'This short link could not be resolved.');
    }
    result = normalized;
  } else {
    result = { ...validateAndNormalizeUrl(finalUrl.toString()), originalUrl: raw };
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(normalized.canonicalUrl, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/** For tests. */
export function clearShortLinkCache(): void {
  cache.clear();
}
