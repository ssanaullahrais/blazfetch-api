import { validateAndNormalizeUrl } from '../utils/url';
import { getAdapter } from '../core/adapters/registry';
import { getCachedMetadataByUrl, setCachedMetadata } from '../core/cache/metadataCache';
import { globalFetchSemaphore } from '../core/jobs/concurrencyLimiter';
import { recordFetchStat } from './statsService';
import { BlazfetchResponse } from '../types/blazfetch';
import { BlazfetchError } from '../constants/errors';

export interface FetchMediaParams {
  url: string;
  requestId: string;
  userId?: string | null;
  guestId?: string | null;
  forceRefresh?: boolean;
  /** 1-based, inclusive item range for collection URLs (Pinterest boards, etc). A ranged
   *  request always bypasses the cache — caching one slice of a collection under the same key
   *  as another would return the wrong items. */
  range?: { start?: number; end?: number };
}

export async function fetchMedia(params: FetchMediaParams): Promise<BlazfetchResponse> {
  const normalizedUrl = validateAndNormalizeUrl(params.url);
  const adapter = getAdapter(normalizedUrl);
  const isRanged = !!(params.range?.start || params.range?.end);

  if (!params.forceRefresh && !isRanged) {
    const cached = await getCachedMetadataByUrl(normalizedUrl.platform, normalizedUrl.canonicalUrl);
    if (cached) return cached;
  }

  const release = await globalFetchSemaphore.acquire();
  const startedAt = Date.now();
  try {
    const result = await adapter.fetchMetadata({ requestId: params.requestId, normalizedUrl, range: params.range });

    if (!isRanged) await setCachedMetadata(result.platform, result.mediaId, result.canonicalUrl, result);
    await recordFetchStat({
      platform: result.platform,
      mediaId: result.mediaId,
      userId: params.userId,
      guestId: params.guestId,
      success: true,
      extractor: result.extractor,
      fallbackUsed: result.fallbackUsed,
      durationMs: Date.now() - startedAt,
    });

    return result;
  } catch (err) {
    const code = err instanceof BlazfetchError ? err.code : 'INTERNAL_ERROR';
    await recordFetchStat({
      platform: normalizedUrl.platform,
      userId: params.userId,
      guestId: params.guestId,
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: code,
    });
    throw err;
  } finally {
    release();
  }
}

