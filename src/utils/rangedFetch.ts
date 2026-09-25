import { Readable } from 'node:stream';
import { BlazfetchError } from '../constants/errors';
import { safeFetch } from './safeFetch';

/**
 * Size of each ranged request. Hosts such as YouTube throttle one long request to about playback speed, but serve
 * requests of up to ~10 MB at full speed (yt-dlp's own `http_chunk_size` for YouTube is the same 10 MB).
 */
export const CHUNK_BYTES = 10 * 1024 * 1024;
const CHUNK_ATTEMPTS = 3;

export interface RangedSource {
  stream: Readable;
  /** 200 when the whole file is sent, 206 for a part of it (see start/end). */
  status: 200 | 206;
  /** Size of the whole file, when the host reports it. */
  totalBytes?: number;
  /** Bytes this stream will deliver, when known. */
  contentLength?: number;
  start: number;
  end?: number;
  contentType?: string;
}

function parseContentRange(header: string | null): { start: number; end: number; total?: number } | null {
  const match = header?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? undefined : Number(match[3]) };
}

async function fetchRange(url: string, from: number, to: number, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  return safeFetch(url, { signal, headers: { ...headers, 'accept-encoding': 'identity', range: `bytes=${from}-${to}` } });
}

/**
 * Reads `url` from byte `start` (to `end`, inclusive, or the end of the file) as a series of CHUNK_BYTES range
 * requests, so a host that throttles long requests still delivers at full speed. A host that ignores Range (answers
 * 200) is simply read in one go. Every request goes through safeFetch, so each redirect is SSRF-checked.
 */
export async function openRanged(
  url: string,
  options: { start?: number; end?: number; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<RangedSource> {
  const { headers = {}, signal } = options;
  const start = options.start ?? 0;
  const firstEnd = options.end !== undefined ? Math.min(options.end, start + CHUNK_BYTES - 1) : start + CHUNK_BYTES - 1;
  const first = await fetchRange(url, start, firstEnd, headers, signal);

  if (first.status === 416) {
    await first.body?.cancel().catch(() => undefined);
    throw new BlazfetchError('DOWNLOAD_FAILED', 'The requested range is outside the file.');
  }
  if (!first.ok || !first.body) {
    await first.body?.cancel().catch(() => undefined);
    throw new BlazfetchError('DOWNLOAD_FAILED', `Failed to fetch media from the source (${first.status}).`);
  }
  const contentType = first.headers.get('content-type') ?? undefined;

  const range = first.status === 206 ? parseContentRange(first.headers.get('content-range')) : null;
  if (!range) {
    // The host sent the whole file (or an unusable partial answer): pass it through as it is.
    if (first.status === 206) {
      await first.body.cancel().catch(() => undefined);
      throw new BlazfetchError('DOWNLOAD_FAILED', 'The source sent a partial answer without a usable Content-Range.');
    }
    const length = Number(first.headers.get('content-length'));
    if (start > 0) {
      // Asked for an offset but got the whole file: the caller wanted a part, so this cannot be used.
      await first.body.cancel().catch(() => undefined);
      throw new BlazfetchError('DOWNLOAD_FAILED', 'The source does not support resuming from an offset.');
    }
    const known = Number.isFinite(length) && length > 0 ? length : undefined;
    return { stream: Readable.fromWeb(first.body as never), status: 200, totalBytes: known, contentLength: known, start: 0, contentType };
  }

  const total = range.total;
  const lastByte = options.end !== undefined ? (total !== undefined ? Math.min(options.end, total - 1) : options.end) : total !== undefined ? total - 1 : undefined;
  const whole = start === 0 && options.end === undefined;

  async function* chunks(): AsyncGenerator<Uint8Array> {
    let next = range!.end + 1;
    for await (const piece of first.body as unknown as AsyncIterable<Uint8Array>) yield piece;
    // Unknown total: keep asking until the host has nothing more to give.
    while (lastByte === undefined || next <= lastByte) {
      const to = lastByte === undefined ? next + CHUNK_BYTES - 1 : Math.min(lastByte, next + CHUNK_BYTES - 1);
      let response: Response | undefined;
      for (let attempt = 1; ; attempt += 1) {
        try {
          response = await fetchRange(url, next, to, headers, signal);
          if (response.status === 416 && lastByte === undefined) return;
          if (response.status !== 206 || !response.body) throw new BlazfetchError('DOWNLOAD_FAILED', `The source answered ${response.status} part-way through.`);
          break;
        } catch (err) {
          await response?.body?.cancel().catch(() => undefined);
          if (signal?.aborted || attempt >= CHUNK_ATTEMPTS) throw err;
        }
      }
      let received = 0;
      for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += piece.byteLength;
        yield piece;
      }
      if (received === 0) return;
      next += received;
    }
  }

  const stream = Readable.from(chunks(), { objectMode: false });
  return {
    stream,
    status: whole ? 200 : 206,
    totalBytes: total,
    contentLength: lastByte !== undefined ? lastByte - start + 1 : undefined,
    start,
    end: lastByte,
    contentType,
  };
}
