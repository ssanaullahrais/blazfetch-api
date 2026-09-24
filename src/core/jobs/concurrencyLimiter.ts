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

const perUserDownloadCounts = new Map<string, number>();

export function acquireUserDownloadSlot(key: string, isGuest: boolean): () => void {
  const limit = isGuest ? env.MAX_CONCURRENT_DOWNLOADS_PER_GUEST : env.MAX_CONCURRENT_DOWNLOADS_PER_USER;
  const current = perUserDownloadCounts.get(key) ?? 0;
  if (current >= limit) {
    throw new BlazfetchError('SERVER_BUSY', 'You have reached your concurrent download limit.');
  }
  perUserDownloadCounts.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const value = (perUserDownloadCounts.get(key) ?? 1) - 1;
    if (value <= 0) perUserDownloadCounts.delete(key);
    else perUserDownloadCounts.set(key, value);
  };
}
