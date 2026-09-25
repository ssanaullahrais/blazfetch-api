import net from 'node:net';
import { Request } from 'express';
import { env } from '../config/env';
import { logger } from '../lib/logger';

let warnedAboutProxy = false;

/**
 * Who a limit is counted against. The guest cookie cannot be used: a client that simply drops it gets a fresh guest
 * id on every request, and with it a fresh limit. A signed-in user is counted by account, everyone else by IP
 * address (req.ip honours TRUST_PROXY). An IPv6 client usually owns a whole /64, so it is counted by that prefix.
 */
export function clientKey(req: Request): string {
  if (req.userId) return `user:${req.userId}`;
  if (!warnedAboutProxy && env.TRUST_PROXY === 0 && req.headers['x-forwarded-for']) {
    warnedAboutProxy = true;
    logger.warn('Requests arrive through a proxy but TRUST_PROXY is 0: every visitor shares the proxy\'s rate limit. Set TRUST_PROXY=1 behind Nginx.');
  }
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  if (net.isIPv6(ip) && !ip.toLowerCase().startsWith('::ffff:')) return `ip6:${ipv6Prefix64(ip)}`;
  return `ip:${ip.replace(/^::ffff:/i, '') || 'unknown'}`;
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
