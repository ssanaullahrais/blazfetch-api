import dns from 'node:dns';
import net from 'node:net';

const BLOCKED_PROTOCOLS = new Set(['file:', 'ftp:', 'gopher:', 'data:', 'javascript:']);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Private/reserved ranges yt-dlp or a fallback fetch must never be allowed to reach,
 * even after DNS resolution (covers rebinding attempts against the whitelist).
 */
function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) {
      // IPv4-mapped in hex form (::ffff:7f00:1 is 127.0.0.1)
      const [hi, lo] = lower.slice(7).split(':').map((h) => parseInt(h, 16));
      return isPrivateOrReservedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) {
      return isPrivateOrReservedIp(lower.replace('::ffff:', ''));
    }
    return false;
  }
  return false;
}

export function assertSafeProtocol(url: URL): void {
  if (BLOCKED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Protocol ${url.protocol} is not allowed`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Protocol ${url.protocol} is not supported`);
  }
}

/** Resolves the hostname and rejects if it points at a private/loopback/link-local address. */
export async function assertNotPrivateHost(hostname: string): Promise<void> {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
    throw new Error('Access to internal hosts is not allowed');
  }
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error('Access to private IP ranges is not allowed');
    }
    return;
  }

  const addresses = await dns.promises.lookup(hostname, { all: true });
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error('Resolved hostname points to a private IP range');
    }
  }
}
