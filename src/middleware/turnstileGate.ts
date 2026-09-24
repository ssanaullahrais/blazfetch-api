import { NextFunction, Request, Response } from 'express';
import { BlazfetchError } from '../constants/errors';
import { passIsValid, TURNSTILE_COOKIE, turnstileEnabled } from '../services/turnstileService';

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); } catch { return undefined; }
    }
  }
  return undefined;
}

/**
 * When Cloudflare Turnstile is enabled, lets a request through only if the visitor holds a valid pass (issued by
 * POST /api/v1/turnstile/verify). A cookie is used, not a header, so plain browser navigations such as GET /stream work.
 */
export function requireTurnstile(req: Request, _res: Response, next: NextFunction): void {
  if (!turnstileEnabled()) return next();
  if (passIsValid(cookieValue(req, TURNSTILE_COOKIE), req.guestId)) return next();
  next(new BlazfetchError('TURNSTILE_REQUIRED', 'Please complete the security check first.'));
}
