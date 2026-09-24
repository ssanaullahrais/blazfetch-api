import { env } from '../../../config/env';
import { BlazfetchError } from '../../../constants/errors';
import { logger } from '../../../lib/logger';

import type { InstagramApiItem, InstagramResponse } from 'btch-downloader/dist/Types/types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * igdl() intermittently returns an empty result array even for valid posts, so we retry a
 * bounded number of times with backoff before treating it as a genuine failure.
 */
export async function fetchInstagramViaBtchDownloader(url: string): Promise<InstagramApiItem[]> {
  let igdl: (url: string) => Promise<InstagramResponse>;
  try {
    igdl = (await import('btch-downloader')).igdl;
  } catch {
    throw new BlazfetchError('EXTRACTOR_FAILED', 'Instagram fallback provider is not installed.');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= env.INSTAGRAM_FALLBACK_MAX_RETRIES; attempt += 1) {
    try {
      const response = await igdl(url);
      if (response.result && response.result.length > 0) return response.result;
      lastError = new Error(response.message ?? 'Empty result from btch-downloader');
    } catch (err) {
      lastError = err;
    }
    logger.debug({ attempt, url }, 'btch-downloader returned empty/failed, retrying');
    if (attempt < env.INSTAGRAM_FALLBACK_MAX_RETRIES) {
      await sleep(env.INSTAGRAM_FALLBACK_RETRY_DELAY_MS * attempt);
    }
  }

  throw new BlazfetchError('EXTRACTOR_FAILED', `Instagram fallback (btch-downloader) failed: ${String(lastError)}`);
}
