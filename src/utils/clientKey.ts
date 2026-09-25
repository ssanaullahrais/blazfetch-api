import net from 'node:net';
import { Request } from 'express';
import { env } from '../config/env';
import { logger } from '../lib/logger';

let warnedAboutProxy = false;

/**
 * The visitor's network, for the per-IP ceilings that sit on top of the per-visitor limits. The guest cookie alone
 * cannot bound anything: a client that drops it gets a fresh guest id, and a fresh limit, on every request.
 *
 * Counted by IP address (req.ip honours TRUST_PROXY); an IPv6 client usually owns a whole /64, so by that prefix.
 * Returns undefined when the address is not the visitor's: a request that came through a proxy while TRUST_PROXY is 0
 * carries the proxy's address, and counting by it would make every visitor share one ceiling. Callers then skip the
 * per-IP ceiling and keep only the per-visitor limit, exactly as before it existed.
 */
export function networkKey(req: Request): string | undefined {
  if (env.TRUST_PROXY === 0 && req.headers['x-forwarded-for']) {
    if (!warnedAboutProxy) {
      warnedAboutProxy = true;
      logger.warn('Requests arrive through a proxy but TRUST_PROXY is 0, so per-IP limits are off. Set TRUST_PROXY=1 behind Nginx.');
    }
    return undefined;
  }
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  if (!ip) return undefined;
  if (net.isIPv6(ip) && !ip.toLowerCase().startsWith('::ffff:')) return `ip6:${ipv6Prefix64(ip)}`;
  return `ip:${ip.replace(/^::ffff:/i, '')}`;
}

function ipv6Prefix64(ip: string): string {
  const [head, tail = ''] = ip.toLowerCase().split('%')[0].split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const full = ip.includes('::')
    ? [...headParts, ...Array<string>(8 - headParts.length - tailParts.length).fill('0'), ...tailParts]
    : headParts;
  return full.slice(0, 4).map((h) => parseInt(h, 16).toString(16)).join(':');
}
