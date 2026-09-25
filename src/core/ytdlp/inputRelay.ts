import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream';
import { logger } from '../../lib/logger';
import { openRanged } from '../../utils/rangedFetch';

/**
 * ffmpeg fetches a URL with one long request, which hosts such as YouTube throttle to about playback speed. So ffmpeg
 * reads each plain-file input from this relay instead: a server on 127.0.0.1 that fetches the real URL in ranged
 * chunks (see openRanged) and honours ffmpeg's own Range requests, so seeking keeps working.
 *
 * Only URLs registered here are served, each under a random token, and only while its ffmpeg process runs. The relay
 * listens on the loopback interface only, and every upstream request goes through safeFetch (SSRF-checked).
 */

interface Entry {
  url: string;
  headers: Record<string, string>;
}

const entries = new Map<string, Entry>();
let listening: Promise<number> | undefined;

function requestedRange(header: string | undefined): { start: number; end?: number } | null {
  const match = header?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  return { start: Number(match[1]), end: match[2] ? Number(match[2]) : undefined };
}

async function serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const token = req.url?.match(/^\/r\/([a-f0-9]{32})$/)?.[1];
  const entry = token ? entries.get(token) : undefined;
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.statusCode = 404;
    res.end();
    return;
  }

  const range = requestedRange(req.headers.range);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const source = await openRanged(entry.url, { start: range?.start, end: range?.end, headers: entry.headers, signal: abort.signal });
    res.setHeader('Accept-Ranges', 'bytes');
    if (source.contentType) res.setHeader('Content-Type', source.contentType);
    if (source.contentLength !== undefined) res.setHeader('Content-Length', String(source.contentLength));
    if (source.totalBytes !== undefined && source.end !== undefined) {
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${source.start}-${source.end}/${source.totalBytes}`);
    } else {
      res.statusCode = 200;
    }
    if (req.method === 'HEAD') {
      source.stream.destroy();
      res.end();
      return;
    }
    pipeline(source.stream, res, () => undefined);
  } catch (err) {
    if (!abort.signal.aborted) logger.warn({ err: (err as Error).message }, 'input relay could not fetch the source');
    if (!res.headersSent) res.statusCode = 502;
    res.end();
  }
}

function start(): Promise<number> {
  listening ??= new Promise<number>((resolve, reject) => {
    const server = http.createServer((req, res) => void serve(req, res));
    server.once('error', (err) => {
      listening = undefined;
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve((server.address() as AddressInfo).port);
    });
  });
  return listening;
}

/** A loopback URL ffmpeg can read `url` from, valid until `release()` is called. */
export async function relayUrl(url: string, headers: Record<string, string> = {}): Promise<{ url: string; release(): void }> {
  const port = await start();
  const token = crypto.randomBytes(16).toString('hex');
  entries.set(token, { url, headers });
  return { url: `http://127.0.0.1:${port}/r/${token}`, release: () => void entries.delete(token) };
}

/** Test hook: how many URLs are currently registered. */
export function relayedUrlCount(): number {
  return entries.size;
}
