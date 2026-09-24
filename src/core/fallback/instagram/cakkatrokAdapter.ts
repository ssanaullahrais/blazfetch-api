import { env } from '../../../config/env';
import { BlazfetchError } from '../../../constants/errors';

export interface CakkatrokResultItem {
  url: string;
  type: 'image' | 'video';
  thumbnail?: string;
}

/**
 * Last-resort Instagram fallback, used only after btch-downloader has completely failed.
 * cakkatrok-instagram-downloader has stricter rate limits than the primary fallback, so this
 * is capped at CAKKATROK_MAX_ATTEMPTS (default 1) and never retried in a loop.
 *
 * The upstream package's API surface is not stable enough to hard-depend on at build time, so
 * this calls it through a configurable HTTP endpoint (CAKKATROK_API_BASE). If you vendor the
 * npm package directly instead, replace the fetch call below with its documented function call.
 */
export async function fetchInstagramViaCakkatrok(url: string): Promise<CakkatrokResultItem[]> {
  if (!env.CAKKATROK_API_BASE) {
    throw new BlazfetchError('EXTRACTOR_FAILED', 'Cakkatrok Instagram fallback is not configured.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.FALLBACK_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.CAKKATROK_API_BASE.replace(/\/$/, '')}/instagram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new BlazfetchError('EXTRACTOR_FAILED', `Cakkatrok fallback responded with ${response.status}.`);
    }

    const data = (await response.json()) as { items?: CakkatrokResultItem[] };
    if (!data.items?.length) {
      throw new BlazfetchError('MEDIA_NOT_FOUND', 'Cakkatrok fallback returned no media.');
    }
    return data.items;
  } finally {
    clearTimeout(timer);
  }
}
