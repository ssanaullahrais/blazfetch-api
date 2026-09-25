import { Request } from 'express';

/** The value of one cookie by its exact name (not a substring of another cookie's name or value). */
export function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); } catch { return undefined; }
    }
  }
  return undefined;
}
