import { logger } from '../lib/logger';
import type { BlazfetchResponse } from '../types/blazfetch';
import { isManifestFormat } from '../core/adapters/formatSelection';
import { safeFetch } from './safeFetch';

const MAX_PROBES = 16;
const PROBE_TIMEOUT_MS = 3000;

/** Total size from a one-byte ranged answer ("bytes 0-0/4443811"), or a plain Content-Length. */
async function probeSize(url: string, signal: AbortSignal): Promise<number | undefined> {
  const res = await safeFetch(url, { signal, headers: { range: 'bytes=0-0', 'accept-encoding': 'identity' } });
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 206) {
    const total = Number(res.headers.get('content-range')?.split('/')[1]);
    return Number.isFinite(total) && total > 0 ? total : undefined;
  }
  const length = Number(res.headers.get('content-length'));
  return res.ok && Number.isFinite(length) && length > 1 ? length : undefined;
}

/**
 * Some extractors list formats without a size and without a duration to estimate one from (Instagram, Facebook).
 * Their formats are plain files, so a one-byte request to each tells the exact size: the app can then show sizes and
 * sort by them. Best effort, in parallel, a few seconds at most; manifests and formats that already have a size are
 * left alone. Mutates and returns the response.
 */
export async function fillMissingSizes(media: BlazfetchResponse, requestId?: string): Promise<BlazfetchResponse> {
  const missing = [...media.formats, ...media.audioFormats].filter(
    (f) => !f.filesizeBytes && f.url && !isManifestFormat({ formatId: f.formatId, url: f.url }),
  );
  if (missing.length === 0) return media;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    await Promise.all(
      missing.slice(0, MAX_PROBES).map(async (format) => {
        const size = await probeSize(format.url as string, abort.signal).catch(() => undefined);
        if (size) {
          format.filesizeBytes = size;
          format.filesizeApprox = false;
        }
      }),
    );
  } catch (err) {
    logger.debug({ requestId, err: (err as Error).message }, 'size probe failed');
  } finally {
    clearTimeout(timer);
  }
  return media;
}
