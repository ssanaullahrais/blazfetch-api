import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { BlazfetchError } from '../constants/errors';

/** Server-to-server credential only. Never accept this key from query strings or cookies. */
export const requireApiKey: RequestHandler = (req, _res, next) => {
  if (!env.API_AUTH_ENABLED) return next();
  const supplied = req.get('X-API-Key');
  if (!supplied || supplied.length > 256) return next(new BlazfetchError('API_AUTH_REQUIRED', 'A valid API key is required.'));
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(env.API_AUTH_KEY))) {
    return next(new BlazfetchError('API_AUTH_REQUIRED', 'A valid API key is required.'));
  }
  next();
};
