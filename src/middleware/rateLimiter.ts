import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { env } from '../config/env';
import { ErrorCode } from '../constants/errors';

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

export const fetchRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: (req: Request) => limitFor(req, env.RATE_LIMIT_MAX_USER, env.RATE_LIMIT_MAX_GUEST),
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler(ErrorCode.PLATFORM_RATE_LIMITED, 'Too many fetch requests. Please slow down.'),
});

export const downloadRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_DOWNLOAD,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler(ErrorCode.SERVER_BUSY, 'Too many download requests. Please slow down.'),
});
