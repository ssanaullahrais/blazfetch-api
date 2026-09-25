import rateLimit from 'express-rate-limit';
import { Request, RequestHandler } from 'express';
import { env } from '../config/env';
import { ErrorCode } from '../constants/errors';
import { networkKey } from '../utils/clientKey';

function keyGenerator(req: Request): string {
  return req.userId ?? req.guestId ?? req.ip ?? 'anonymous';
}

function limitFor(req: Request, userMax: number, guestMax: number): number {
  return req.userId ? userMax : guestMax;
}

function jsonLimitHandler(code: string, message: string) {
  return (req: Request, res: import('express').Response) => {
    res.status(429).json({ success: false, error: { code, message }, requestId: req.requestId });
  };
}

/**
 * A ceiling per IP address on top of the per-visitor limit. The per-visitor limit is keyed by the guest cookie, which
 * a client can drop to start over; this bounds that. It is RATE_LIMIT_IP_MULTIPLIER times the per-visitor limit, so
 * several people on one address (an office, a mobile carrier) never notice it. Signed-in users and requests whose IP
 * is not the visitor's (see networkKey) skip it.
 */
function networkCeiling(guestMax: number, code: string, message: string): RequestHandler {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: guestMax * env.RATE_LIMIT_IP_MULTIPLIER,
    keyGenerator: (req: Request) => networkKey(req) as string,
    skip: (req: Request) => !!req.userId || networkKey(req) === undefined,
    standardHeaders: false,
    legacyHeaders: false,
    handler: jsonLimitHandler(code, message),
  });
}

const FETCH_MESSAGE = 'Too many fetch requests. Please slow down.';
const DOWNLOAD_MESSAGE = 'Too many download requests. Please slow down.';

export const fetchRateLimiter: RequestHandler[] = [
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: (req: Request) => limitFor(req, env.RATE_LIMIT_MAX_USER, env.RATE_LIMIT_MAX_GUEST),
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    handler: jsonLimitHandler(ErrorCode.PLATFORM_RATE_LIMITED, FETCH_MESSAGE),
  }),
  networkCeiling(env.RATE_LIMIT_MAX_GUEST, ErrorCode.PLATFORM_RATE_LIMITED, FETCH_MESSAGE),
];

export const downloadRateLimiter: RequestHandler[] = [
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX_DOWNLOAD,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    handler: jsonLimitHandler(ErrorCode.SERVER_BUSY, DOWNLOAD_MESSAGE),
  }),
  networkCeiling(env.RATE_LIMIT_MAX_DOWNLOAD, ErrorCode.SERVER_BUSY, DOWNLOAD_MESSAGE),
];
