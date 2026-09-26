import { getDb } from '../db';
import { logger } from '../lib/logger';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  ts: number;
  level: LogLevel;
  message: string;
}

export interface LogAttempt {
  requestId: string;
  startedAt: number;
  lines: LogLine[];
}

/** How many of a media's most recent attempts GET /media/<platform>/<id>/logs returns. */
const MAX_ATTEMPTS_RETURNED = 10;

/**
 * Starts tracking one download/stream attempt in the database (see downloadLogs in db/types.ts), so its log
 * lines can be looked up later at GET /media/<platform>/<id>/logs. Best-effort and fire-and-forget: a failure
 * here must never affect the download itself. A media key that can't be predicted from the URL up front (every
 * platform except YouTube, whose id is in the URL itself) is simply never tracked.
 */
export function beginAttempt(params: { requestId: string; platform: string; mediaKey: string; guestId?: string; userId?: string }): Promise<void> {
  return getDb()
    .downloadLogs.begin(params)
    .catch((err) => logger.warn({ requestId: params.requestId, err: (err as Error).message }, 'failed to record a download-log attempt start'));
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// A deliberately loose IPv6 match (hex groups joined by colons, including the "::" zero-compression form): good
// enough to redact an address embedded in a URL or error message without needing to fully validate IPv6 syntax.
const IPV6 = /\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}\b/gi;

/** Strips anything that looks like an IP address (the visitor's own, or one from an upstream CDN URL in an error
 * message) before a line is ever stored or shown back to a visitor. */
function redact(message: string): string {
  return message.replace(IPV4, '[ip]').replace(IPV6, '[ip]');
}

/** Records one line against a tracked attempt, and always logs through the normal server logger too (the real,
 * unredacted message — redaction only applies to what a visitor can read back via getMediaDownloadLogs).
 * Fire-and-forget, like beginAttempt: never lets a logging failure affect the download itself. A no-op on the
 * storage side when `requestId` was never begun. */
export function record(requestId: string, level: LogLevel, message: string): Promise<void> {
  logger[level]({ requestId }, message);
  return getDb()
    .downloadLogs.appendLine(requestId, level, redact(message))
    .catch((err) => logger.warn({ requestId, err: (err as Error).message }, 'failed to record a download-log line'));
}

/**
 * Recent attempts for this media, most recent first, or undefined when none are on record. Public — no
 * ownership check: anyone who knows a media's platform/id can look these up, for now, until an admin-only view
 * replaces this (see GET /media/<platform>/<id>/logs).
 */
export async function getMediaDownloadLogs(platform: string, mediaKey: string): Promise<LogAttempt[] | undefined> {
  const attempts = await getDb().downloadLogs.listForMedia(platform, mediaKey, MAX_ATTEMPTS_RETURNED);
  if (attempts.length === 0) return undefined;
  return attempts.map((a) => ({
    requestId: a.requestId,
    startedAt: new Date(a.startedAt).getTime(),
    lines: a.lines.map((l) => ({ ts: new Date(l.ts).getTime(), level: l.level, message: l.message })),
  }));
}
