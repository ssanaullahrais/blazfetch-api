import { env } from '../../../config/env';
import { BlazfetchError } from '../../../constants/errors';
import { logger } from '../../../lib/logger';

export interface BtchYoutubeResult {
  title: string;
  thumbnail?: string;
  author?: string;
  /** Direct MP3 link (short-lived). */
  mp3?: string;
  /** Direct MP4 link (short-lived). */
  mp4?: string;
}

interface RawBtchYoutube {
  status?: boolean;
  title?: string;
  thumbnail?: string;
  author?: string;
  mp3?: string;
  mp4?: string;
  message?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * YouTube fallback provider (btch-downloader). Used only when yt-dlp is blocked by YouTube's bot check
 * or otherwise fails; it works from IPs YouTube has flagged. Retries a couple of times because these
 * public services are intermittent, and never waits longer than FALLBACK_TIMEOUT_MS per attempt.
 */
export async function fetchYoutubeViaBtch(url: string): Promise<BtchYoutubeResult> {
  let youtube: (url: string) => Promise<RawBtchYoutube>;
  try {
    youtube = (await import('btch-downloader')).youtube as unknown as typeof youtube;
  } catch {
    throw new BlazfetchError('EXTRACTOR_FAILED', 'YouTube fallback provider is not installed.');
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= env.YOUTUBE_FALLBACK_ATTEMPTS; attempt += 1) {
    try {
      const response = await Promise.race([
        youtube(url),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), env.FALLBACK_TIMEOUT_MS)),
      ]);
      if (response.status !== false && response.title && (response.mp4 || response.mp3)) {
        return { title: response.title, thumbnail: response.thumbnail, author: response.author, mp3: response.mp3, mp4: response.mp4 };
      }
      lastError = new Error(response.message ?? 'empty result');
    } catch (err) {
      lastError = err;
    }
    logger.debug({ attempt, url }, 'YouTube fallback returned nothing usable, retrying');
    if (attempt < env.YOUTUBE_FALLBACK_ATTEMPTS) await sleep(1000 * attempt);
  }

  throw new BlazfetchError('EXTRACTOR_FAILED', `YouTube fallback (btch-downloader) failed: ${String(lastError)}`);
}
