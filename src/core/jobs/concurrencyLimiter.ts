import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';

/** Simple in-memory FIFO-respecting semaphore. One process per Node instance is assumed;
 *  a multi-instance deployment should back this with a shared store (e.g. Redis) instead. */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  get activeCount(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export const globalDownloadSemaphore = new Semaphore(env.MAX_CONCURRENT_DOWNLOADS_GLOBAL);
export const globalFetchSemaphore = new Semaphore(env.MAX_CONCURRENT_FETCHES_GLOBAL);

const perKeyDownloadCounts = new Map<string, number>();

function acquireKeyedSlot(key: string, limit: number): () => void {
  const current = perKeyDownloadCounts.get(key) ?? 0;
  if (current >= limit) {
    throw new BlazfetchError('SERVER_BUSY', 'You have reached your concurrent download limit.');
  }
  perKeyDownloadCounts.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const value = (perKeyDownloadCounts.get(key) ?? 1) - 1;
    if (value <= 0) perKeyDownloadCounts.delete(key);
    else perKeyDownloadCounts.set(key, value);
  };
}

export function acquireUserDownloadSlot(key: string, isGuest: boolean): () => void {
  return acquireKeyedSlot(`visitor:${key}`, isGuest ? env.MAX_CONCURRENT_DOWNLOADS_PER_GUEST : env.MAX_CONCURRENT_DOWNLOADS_PER_USER);
}

/**
 * The per-guest slot plus, for guests, a per-network slot (see clientKey). The guest id comes from a cookie the
 * client controls, so on its own it would let a client that drops the cookie start unlimited downloads.
 */
export function acquireVisitorDownloadSlots(visitor: { userId?: string | null; guestId?: string | null; networkKey?: string }): () => void {
  const releaseVisitor = acquireUserDownloadSlot(visitor.userId ?? visitor.guestId ?? 'anonymous', !visitor.userId);
  if (visitor.userId || !visitor.networkKey) return releaseVisitor;
  let releaseNetwork: () => void;
  try {
    releaseNetwork = acquireKeyedSlot(`network:${visitor.networkKey}`, env.MAX_CONCURRENT_DOWNLOADS_PER_IP);
  } catch (err) {
    releaseVisitor();
    throw err;
  }
  return () => {
    releaseVisitor();
    releaseNetwork();
  };
}
