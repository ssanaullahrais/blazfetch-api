import { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { BlazfetchError } from '../constants/errors';
import { issuePass, TURNSTILE_COOKIE, turnstileEnabled, verifyTurnstileToken } from '../services/turnstileService';

export const verifyBodySchema = z.object({ token: z.string().min(1).max(2048) });

/** Public settings the frontend needs, so the site key is configured in one place (the backend .env). */
export function getConfig(_req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    turnstile: turnstileEnabled() ? { enabled: true, siteKey: env.TURNSTILE_SITE_KEY, sessionSeconds: env.TURNSTILE_SESSION_SECONDS, action: env.TURNSTILE_EXPECTED_ACTION } : { enabled: false },
  });
}

/** Swaps a solved widget token for a pass cookie. */
export async function postTurnstileVerify(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (!turnstileEnabled()) {
    res.json({ success: true, enabled: false });
    return;
  }
  if (!req.guestId) throw new BlazfetchError('TURNSTILE_FAILED', 'No visitor session.');
  await verifyTurnstileToken((req.body as z.infer<typeof verifyBodySchema>).token, req.ip);
  const pass = issuePass(req.guestId);
  res.cookie(TURNSTILE_COOKIE, pass.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.APP_ENV === 'production',
    maxAge: pass.maxAgeSeconds * 1000,
  });
  res.json({ success: true, enabled: true, expiresIn: pass.maxAgeSeconds });
}
