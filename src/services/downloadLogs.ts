import { logger } from '../lib/logger';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  ts: number;
  level: LogLevel;
  message: string;
}

export interface LogAttempt {
  requestId: string;
  platform: string;
  mediaKey: string;
  guestId?: string;
  userId?: string;
  startedAt: number;
  lines: LogLine[];
}

const MAX_LINES_PER_ATTEMPT = 200;
const MAX_ATTEMPTS_TRACKED = 2000;
const MAX_ATTEMPTS_PER_MEDIA = 10;
const ATTEMPT_TTL_MS = 2 * 60 * 60 * 1000; // how long a finished attempt's log stays available to look up

const attempts = new Map<string, LogAttempt>(); // requestId -> attempt, oldest first (Map preserves insertion order)
const byMedia = new Map<string, string[]>(); // "platform:mediaKey" -> requestIds, oldest first

const mediaIndexKey = (platform: string, mediaKey: string): string => `${platform}:${mediaKey}`;

/**
 * Starts tracking one download/stream attempt so its log lines can be looked up later by whoever started
 * it (see getVisitorLogs). Best-effort and in-memory only: a media key that can't be predicted from the
 * URL up front (every platform except YouTube, whose id is in the URL itself) is simply never tracked,
 * and a restart of the process drops everything — this is a debugging aid, not a permanent record.
 */
export function beginAttempt(params: { requestId: string; platform: string; mediaKey: string; guestId?: string; userId?: string }): void {
  attempts.set(params.requestId, { ...params, startedAt: Date.now(), lines: [] });

  const key = mediaIndexKey(params.platform, params.mediaKey);
  const list = byMedia.get(key) ?? [];
  list.push(params.requestId);
  while (list.length > MAX_ATTEMPTS_PER_MEDIA) {
    const dropped = list.shift();
    if (dropped) attempts.delete(dropped);
  }
  byMedia.set(key, list);

  if (attempts.size > MAX_ATTEMPTS_TRACKED) {
    const oldest = attempts.keys().next().value;
    if (oldest) attempts.delete(oldest);
  }
}

/** Records one line against a tracked attempt, and always logs through the normal server logger too. A
 * no-op on the tracking side when `requestId` was never registered (see beginAttempt). */
export function record(requestId: string, level: LogLevel, message: string): void {
  logger[level]({ requestId }, message);
  attempts.get(requestId)?.lines.push({ ts: Date.now(), level, message });
  const attempt = attempts.get(requestId);
  if (attempt && attempt.lines.length > MAX_LINES_PER_ATTEMPT) attempt.lines.shift();
}

/** The visitor (guest or logged-in user) who started an attempt for this media can look its own attempts'
 * logs back up; nobody else can. Returns the most recent attempts first, or undefined when this visitor
 * has none on record (including "never tracked at all" and "the attempt already expired"). */
export function getVisitorLogs(platform: string, mediaKey: string, guestId?: string, userId?: string): LogAttempt[] | undefined {
  const list = byMedia.get(mediaIndexKey(platform, mediaKey));
  if (!list) return undefined;
  const own = list
    .map((id) => attempts.get(id))
    .filter((a): a is LogAttempt => !!a && ((!!userId && a.userId === userId) || (!!guestId && a.guestId === guestId)))
    .reverse();
  return own.length ? own : undefined;
}

// Drops attempts old enough that nobody is still watching them, so the in-memory store doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - ATTEMPT_TTL_MS;
  for (const [id, attempt] of attempts) {
    if (attempt.startedAt < cutoff) attempts.delete(id);
  }
  for (const [key, list] of byMedia) {
    const kept = list.filter((id) => attempts.has(id));
    if (kept.length) byMedia.set(key, kept);
    else byMedia.delete(key);
  }
}, 10 * 60 * 1000).unref();
