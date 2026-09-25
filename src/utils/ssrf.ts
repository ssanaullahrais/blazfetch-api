import dns from 'node:dns';
import net from 'node:net';

const BLOCKED_PROTOCOLS = new Set(['file:', 'ftp:', 'gopher:', 'data:', 'javascript:']);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** IPv4 ranges that are not the public internet (RFC 6890 special-purpose registry, plus multicast/reserved). */
const BLOCKED_V4 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}

/** Expands an IPv6 address (any valid textual form, including an embedded dotted IPv4 tail) into 8 numbers. */
function ipv6Hextets(ip: string): number[] | null {
  let address = ip.toLowerCase().split('%')[0];
  const dotted = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    address = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((h) => parseInt(h, 16));
  return parts.length === 8 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parts : null;
}

const v4FromHextets = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Private/reserved ranges yt-dlp or a fallback fetch must never be allowed to reach. IPv6 forms that carry an IPv4
 * address (IPv4-mapped, IPv4-compatible, NAT64, 6to4) are judged by the IPv4 address inside them.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return BLOCKED_V4.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return false;

  const h = ipv6Hextets(ip);
  if (!h) return true; // unparseable: refuse rather than guess

  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped)
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0 || h5 === 0xffff)) {
    if (h5 === 0 && h6 === 0) return true; // :: and ::1
    return isPrivateOrReservedIp(v4FromHextets(h6, h7));
  }
  // 64:ff9b::/96 (NAT64 well-known prefix) and 64:ff9b:1::/48 (local-use NAT64)
  if (h0 === 0x64 && h1 === 0xff9b) {
    if (h2 === 1) return true;
    return isPrivateOrReservedIp(v4FromHextets(h6, h7));
  }
  if (h0 === 0x2002) return isPrivateOrReservedIp(v4FromHextets(h1, h2)); // 6to4 carries the IPv4 address next
  if (h0 === 0x2001 && h1 === 0) return true; // Teredo
  if (h0 === 0x2001 && h1 === 0xdb8) return true; // documentation
  if (h0 === 0x100 && h1 === 0 && h2 === 0 && h3 === 0) return true; // discard-only
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h0 & 0xff00) === 0xff00) return true; // multicast
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
export async function assertNotPrivateHost(rawHostname: string): Promise<void> {
  // URL.hostname keeps the brackets around an IPv6 literal, and a trailing dot is the same host.
  const hostname = rawHostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '').toLowerCase();
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
