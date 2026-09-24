import { env } from '../config/env';
import { validateAndNormalizeUrl, NormalizedUrlResult } from '../utils/url';
import { getAdapter } from '../core/adapters/registry';
import { PlatformAdapter } from '../core/adapters/types';
import { globalFetchSemaphore } from '../core/jobs/concurrencyLimiter';
import {
  buildMediaPath,
  isMixPlaylist,
  kindOfKey,
  mediaKeyForResponse,
  playlistKey,
  predictedMediaKey,
} from '../core/media/mediaPath';
import { getDb } from '../db';
import { StoredMedia } from '../db/types';
import { recordFetchStat } from './statsService';
import { BlazfetchResponse, StoredInfo } from '../types/blazfetch';
import { BlazfetchError } from '../constants/errors';
import { logger } from '../lib/logger';

export interface FetchMediaParams {
  url: string;
  requestId: string;
  userId?: string | null;
  guestId?: string | null;
  forceRefresh?: boolean;
  /** 1-based, inclusive item range for collection URLs (Pinterest boards, etc). A ranged
   *  request always bypasses the store — keeping one slice of a collection under the same key
   *  as another would return the wrong items. */
  range?: { start?: number; end?: number };
  /** The caller is about to use the direct media URLs in the response (e.g. GET /stream), so a
   *  stored answer whose URLs are past their trust window is re-extracted first. */
  requireFreshUrls?: boolean;
}

/** "Gone" answers. Timeouts, rate limits and extractor hiccups say nothing about whether media still exists. */
const PERMANENT_CODES = new Set<string>(['MEDIA_NOT_FOUND', 'PRIVATE_MEDIA']);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Live extractions currently running, so simultaneous requests for one item extract it once. */
const inFlight = new Map<string, Promise<BlazfetchResponse>>();

/** Results extracted with the operator's own login must never be served to the public. */
export function isPublicSource(platform: string): boolean {
  return !(platform === 'instagram' && env.INSTAGRAM_COOKIES_PATH);
}

function safeStat(params: Parameters<typeof recordFetchStat>[0]): void {
  void recordFetchStat(params).catch((err) => logger.warn({ err: (err as Error).message }, 'failed to record fetch stat'));
}

/** How long the direct media URLs (and, for playlists, the item list) in a stored response are trusted. */
function freshnessMs(platform: string, mediaKey: string): number {
  const isPlaylist = kindOfKey(mediaKey) === 'playlist' && !isMixPlaylist(platform, mediaKey);
  return (isPlaylist ? env.PLAYLIST_REFRESH_SECONDS : env.CACHE_TTL_SECONDS) * 1000;
}

/** Fallback providers hand out links that die within a minute, so an answer from one is trusted only briefly. */
function urlTrustMs(result: BlazfetchResponse, mediaKey: string): number {
  const base = freshnessMs(result.platform, mediaKey);
  return result.fallbackUsed ? Math.min(base, env.FALLBACK_LINK_TTL_SECONDS * 1000) : base;
}

function storedInfo(record: StoredMedia, extra: { cached: boolean; validationFailed?: boolean; playlistPath?: string }): StoredInfo {
  return {
    path: record.path ?? buildMediaPath(record.platform, record.mediaKey),
    ...(extra.playlistPath ? { playlistPath: extra.playlistPath } : {}),
    sourceUrl: record.sourceUrl,
    status: record.status,
    cached: extra.cached,
    urlsStale: new Date(record.urlsExpireAt).getTime() <= Date.now(),
    ...(extra.validationFailed ? { validationFailed: true } : {}),
    firstFetchedAt: record.firstFetchedAt,
    lastFetchedAt: record.lastFetchedAt,
    validatedAt: record.validatedAt,
    nextCheckAt: record.nextCheckAt,
    stats: {
      ...record.counters,
      lastAccessedAt: record.lastAccessedAt,
      lastDownloadedAt: record.lastDownloadedAt,
    },
  };
}

/** The stored response without any of our own bookkeeping, as it came from the source. */
function stripStored(response: BlazfetchResponse): BlazfetchResponse {
  const { stored: _stored, ...rest } = response;
  return rest as BlazfetchResponse;
}

function tombstoneError(record: StoredMedia): BlazfetchError {
  return new BlazfetchError('MEDIA_UNAVAILABLE', 'This media is no longer available at the source.', {
    tombstone: {
      platform: record.platform,
      path: record.path,
      title: record.metadata.title ?? record.metadata.playlist?.title ?? null,
      thumbnail: record.metadata.thumbnail ?? null,
      reason: record.unavailableReason,
      unavailableSince: record.unavailableSince,
      lastSeenAvailable: record.validatedAt,
      sourceUrl: record.sourceUrl,
    },
  });
}

async function findStored(normalized: NormalizedUrlResult): Promise<StoredMedia | null> {
  const key = predictedMediaKey(normalized);
  const store = getDb().metadataCache;
  return key ? store.findByKey(normalized.platform, key) : store.findByUrl(normalized.platform, normalized.canonicalUrl);
}

export async function fetchMedia(params: FetchMediaParams): Promise<BlazfetchResponse> {
  const normalized = validateAndNormalizeUrl(params.url);
  const adapter = getAdapter(normalized);
  const isRanged = !!(params.range?.start || params.range?.end);

  const stored = isRanged ? null : await findStored(normalized);

  if (stored && !params.forceRefresh) {
    const now = Date.now();

    if (stored.status === 'unavailable') {
      // Known to be gone. Don't re-extract on every request; look again only every so often.
      const lastCheck = stored.lastCheckAt ? new Date(stored.lastCheckAt).getTime() : 0;
      if (now - lastCheck < env.UNAVAILABLE_RECHECK_SECONDS * 1000) {
        safeStat({ platform: stored.platform, mediaId: stored.mediaKey, userId: params.userId, guestId: params.guestId, success: false, cacheHit: true, errorCode: 'MEDIA_UNAVAILABLE', kind: stored.kind });
        throw tombstoneError(stored);
      }
    } else {
      const checkDue = !stored.nextCheckAt || new Date(stored.nextCheckAt).getTime() <= now;
      const urlsFresh = new Date(stored.urlsExpireAt).getTime() > now;

      if (!checkDue && (urlsFresh || !params.requireFreshUrls)) {
        if (!urlsFresh) {
          // Serve what we have right away and refresh the media URLs behind the scenes.
          void extractLive(normalized, adapter, params, stored, 'user').catch((err) =>
            logger.warn({ requestId: params.requestId, err: (err as Error).message }, 'background refresh failed'),
          );
        }
        void getDb().metadataCache.recordAccess(stored.platform, stored.mediaKey, 'hit').catch(() => undefined);
        safeStat({
          platform: stored.platform,
          mediaId: stored.mediaKey,
          userId: params.userId,
          guestId: params.guestId,
          success: true,
          extractor: stored.metadata.extractor,
          cacheHit: true,
          cacheStale: !urlsFresh,
          kind: stored.kind,
        });
        return decorate(stored, { cached: true, playlistPath: playlistPathFor(normalized) });
      }
      // The weekly existence check is due (or fresh URLs are required): extract live below.
    }
  }

  return extractLive(normalized, adapter, params, stored, 'user');
}

function playlistPathFor(normalized: NormalizedUrlResult): string | undefined {
  return normalized.videoId && normalized.playlistId
    ? buildMediaPath(normalized.platform, playlistKey(normalized.playlistId), normalized.videoId)
    : undefined;
}

function decorate(record: StoredMedia, extra: { cached: boolean; validationFailed?: boolean; playlistPath?: string }): BlazfetchResponse {
  return { ...stripStored(record.metadata), stored: storedInfo(record, extra) };
}

/**
 * Extracts from the source, then stores the result (kept forever) and marks the item validated.
 * When the extraction fails, the failure is recorded against the stored item so repeated "gone"
 * answers eventually mark it unavailable, while one flaky answer does not.
 */
async function extractLive(
  normalized: NormalizedUrlResult,
  adapter: PlatformAdapter,
  params: FetchMediaParams,
  stored: StoredMedia | null,
  source: 'user' | 'revalidation',
): Promise<BlazfetchResponse> {
  const isRanged = !!(params.range?.start || params.range?.end);
  const dedupeKey = `${normalized.platform}|${stored?.mediaKey ?? predictedMediaKey(normalized) ?? normalized.canonicalUrl}`;

  if (!isRanged) {
    const running = inFlight.get(dedupeKey);
    if (running) return running;
  }

  const run = (async (): Promise<BlazfetchResponse> => {
    const release = await globalFetchSemaphore.acquire();
    const startedAt = Date.now();
    try {
      const result = await adapter.fetchMetadata({ requestId: params.requestId, normalizedUrl: normalized, range: params.range });

      if (isRanged) {
        await recordFetchStat({
          platform: result.platform,
          mediaId: result.mediaId,
          userId: params.userId,
          guestId: params.guestId,
          success: true,
          extractor: result.extractor,
          fallbackUsed: result.fallbackUsed,
          durationMs: Date.now() - startedAt,
          cacheHit: false,
          source,
        });
        return result;
      }

      const mediaKey = mediaKeyForResponse(result);
      const path = buildMediaPath(result.platform, mediaKey);
      const clean = stripStored(result);
      await getDb().metadataCache.upsert({
        platform: result.platform,
        mediaKey,
        canonicalUrl: result.canonicalUrl,
        sourceUrl: stored?.sourceUrl ?? normalized.originalUrl,
        path,
        metadata: clean,
        isPublic: isPublicSource(result.platform),
        urlsExpireAt: new Date(Date.now() + urlTrustMs(result, mediaKey)),
        nextCheckAt: new Date(Date.now() + env.REVALIDATE_AFTER_SECONDS * 1000),
      });

      await recordFetchStat({
        platform: result.platform,
        mediaId: mediaKey,
        userId: params.userId,
        guestId: params.guestId,
        success: true,
        extractor: result.extractor,
        fallbackUsed: result.fallbackUsed,
        durationMs: Date.now() - startedAt,
        cacheHit: false,
        kind: kindOfKey(mediaKey),
        source,
      });

      const record = await getDb().metadataCache.findByKey(result.platform, mediaKey);
      return record ? decorate(record, { cached: false, playlistPath: playlistPathFor(normalized) }) : result;
    } catch (err) {
      const code = err instanceof BlazfetchError ? err.code : 'INTERNAL_ERROR';
      await recordFetchStat({
        platform: normalized.platform,
        mediaId: stored?.mediaKey,
        userId: params.userId,
        guestId: params.guestId,
        success: false,
        durationMs: Date.now() - startedAt,
        errorCode: code,
        cacheHit: false,
        source,
      });
      return await handleFailure(err, code, stored, params, source);
    } finally {
      release();
    }
  })();

  if (!isRanged) {
    inFlight.set(dedupeKey, run);
    void run.then(
      () => inFlight.delete(dedupeKey),
      () => inFlight.delete(dedupeKey),
    );
  }
  return run;
}

/** Records the failure against the stored item and decides whether the caller still gets the stored answer. */
async function handleFailure(
  err: unknown,
  code: string,
  stored: StoredMedia | null,
  params: FetchMediaParams,
  source: 'user' | 'revalidation',
): Promise<BlazfetchResponse> {
  if (!stored) throw err;

  const permanent = PERMANENT_CODES.has(code);
  // Below the threshold a "gone" answer is retried tomorrow; a timeout or rate limit is retried soon.
  const retryMs = permanent ? DAY_MS : env.TRANSIENT_RETRY_SECONDS * 1000;
  const outcome = await getDb().metadataCache.recordCheckFailure(stored.platform, stored.mediaKey, {
    code,
    permanent,
    threshold: env.UNAVAILABLE_AFTER_FAILURES,
    nextCheckAt: new Date(Date.now() + retryMs),
  });

  if (outcome.status === 'unavailable') {
    logger.info({ requestId: params.requestId, platform: stored.platform, key: stored.mediaKey, code }, 'stored media is no longer available');
    const record = await getDb().metadataCache.findByKey(stored.platform, stored.mediaKey);
    if (source === 'user' && record && permanent) throw tombstoneError(record);
    throw err;
  }

  // Not proven gone. If the caller only needs the stored answer, give it (flagged), otherwise report the error.
  if (source === 'user' && !params.forceRefresh && !params.requireFreshUrls) {
    logger.warn({ requestId: params.requestId, code, key: stored.mediaKey }, 'live check failed, serving the stored answer');
    return decorate(stored, { cached: true, validationFailed: true });
  }
  throw err;
}

export type RevalidationOutcome = 'available' | 'unavailable' | 'failed' | 'skipped';

/**
 * Re-checks that one stored item still exists (used by the weekly background job). Returns what the
 * check found; the stored row is updated either way.
 */
export async function revalidateStored(record: StoredMedia, requestId: string): Promise<RevalidationOutcome> {
  const store = getDb().metadataCache;

  // Anything that was only reachable with the operator's login can't be re-checked anonymously.
  if (!record.isPublic) {
    await store.scheduleNextCheck(record.platform, record.mediaKey, new Date(Date.now() + env.REVALIDATE_AFTER_SECONDS * 1000));
    return 'skipped';
  }

  try {
    const normalized = validateAndNormalizeUrl(record.canonicalUrl);
    await extractLive(normalized, getAdapter(normalized), { url: record.canonicalUrl, requestId }, record, 'revalidation');
    return 'available';
  } catch (err) {
    const after = await store.findByKey(record.platform, record.mediaKey);
    logger.info({ requestId, key: record.mediaKey, err: (err as Error).message }, 'revalidation did not confirm the media');
    return after?.status === 'unavailable' ? 'unavailable' : 'failed';
  }
}
