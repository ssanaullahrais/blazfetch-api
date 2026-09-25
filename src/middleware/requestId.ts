import { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { cookieValue } from '../utils/cookies';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      guestId?: string;
      userId?: string;
    }
  }
}

const GUEST_COOKIE = 'blazfetch_guest_id';
// A caller-supplied request id ends up in logs and a response header, so only a short, plain token is accepted.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
// Guest ids are always issued by this server as UUIDs; anything else is replaced with a fresh one.
const GUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  req.requestId = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : uuidv4();
  res.setHeader('X-Request-Id', req.requestId);

  const guest = cookieValue(req, GUEST_COOKIE);
  req.guestId = guest && GUEST_ID_PATTERN.test(guest) ? guest : uuidv4();
  res.cookie?.(GUEST_COOKIE, req.guestId, { httpOnly: true, sameSite: 'lax', secure: env.APP_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 30 });

  next();
}
