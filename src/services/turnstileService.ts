import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { BlazfetchError } from '../constants/errors';
import { logger } from '../lib/logger';

/** Cloudflare's documented verification endpoint. */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_COOKIE = 'blazfetch_turnstile';

const VERIFY_TIMEOUT_MS = 8000;

export function turnstileEnabled(): boolean {
  return env.TURNSTILE_ENABLED;
}

function signingKey(): string {
  return env.TURNSTILE_COOKIE_SECRET || createHash('sha256').update(`blazfetch-turnstile:${env.TURNSTILE_SECRET_KEY}`).digest('hex');
}

const sign = (payload: string): string => createHmac('sha256', signingKey()).update(payload).digest('base64url');

/** A short-lived proof that this visitor passed the check: `<expiry>.<guest id>.<signature>`. Bound to the guest cookie. */
export function issuePass(guestId: string, now = Date.now()): { value: string; maxAgeSeconds: number } {
  const expiresAt = Math.floor(now / 1000) + env.TURNSTILE_SESSION_SECONDS;
  const payload = `${expiresAt}.${guestId}`;
  return { value: `${payload}.${sign(payload)}`, maxAgeSeconds: env.TURNSTILE_SESSION_SECONDS };
}

export function passIsValid(cookieValue: string | undefined, guestId: string | undefined, now = Date.now()): boolean {
  if (!cookieValue || !guestId) return false;
  const parts = cookieValue.split('.');
  if (parts.length < 3) return false;
  const signature = parts.pop() as string;
  const payload = parts.join('.');
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const [expiresAt, ...rest] = payload.split('.');
  return Number(expiresAt) > Math.floor(now / 1000) && rest.join('.') === guestId;
}

/**
 * Checks a widget token with Cloudflare. Tokens are single use and expire after 5 minutes, so a token is only ever
 * verified once here and then swapped for the pass cookie above.
 */
export async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY) {
    throw new BlazfetchError('INTERNAL_ERROR', 'Turnstile is enabled but TURNSTILE_SECRET_KEY is not set.');
  }
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  let result: { success?: boolean; hostname?: string; action?: string; 'error-codes'?: string[] };
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Siteverify returned HTTP ${res.status}`);
    result = (await res.json()) as typeof result;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'turnstile verification request failed');
    throw new BlazfetchError('TURNSTILE_FAILED', 'The security check could not be verified right now. Please try again.');
  }
  const allowedHosts = env.TURNSTILE_ALLOWED_HOSTNAMES.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (result?.success !== true ||
      (allowedHosts.length > 0 && !allowedHosts.includes(result.hostname?.toLowerCase() ?? '')) ||
      (env.TURNSTILE_EXPECTED_ACTION && result.action !== env.TURNSTILE_EXPECTED_ACTION)) {
    logger.info({ errors: result?.['error-codes'] }, 'turnstile token rejected');
    throw new BlazfetchError('TURNSTILE_FAILED', 'The security check failed. Please try again.', { errorCodes: result?.['error-codes'] ?? [] });
  }
}
