import { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';

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

export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = (req.headers['x-request-id'] as string) || uuidv4();
  res.setHeader('X-Request-Id', req.requestId);

  const cookieHeader = req.headers.cookie ?? '';
  const match = cookieHeader.match(new RegExp(`${GUEST_COOKIE}=([^;]+)`));
  req.guestId = match ? match[1] : uuidv4();
  res.cookie?.(GUEST_COOKIE, req.guestId, { httpOnly: true, sameSite: 'lax', secure: env.APP_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 30 });

  next();
}
