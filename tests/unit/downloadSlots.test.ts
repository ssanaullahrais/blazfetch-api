import { describe, expect, it } from 'vitest';
import { acquireVisitorDownloadSlots } from '../../src/core/jobs/concurrencyLimiter';

describe('per-visitor download slots', () => {
  it('gives video and audio their own slot, so one does not block the other', () => {
    const guest = { guestId: 'slot-test-a', networkKey: 'net-a' };
    const video = acquireVisitorDownloadSlots({ ...guest, kind: 'video' });
    const audio = acquireVisitorDownloadSlots({ ...guest, kind: 'audio' }); // does not throw
    expect(() => acquireVisitorDownloadSlots({ ...guest, kind: 'video' })).toThrow(/concurrent download limit/);
    expect(() => acquireVisitorDownloadSlots({ ...guest, kind: 'audio' })).toThrow(/concurrent download limit/);
    video();
    audio();
  });

  it('frees a slot when it is released, and defaults to video', () => {
    const guest = { guestId: 'slot-test-b', networkKey: 'net-b' };
    const first = acquireVisitorDownloadSlots(guest);
    expect(() => acquireVisitorDownloadSlots({ ...guest, kind: 'video' })).toThrow();
    first();
    acquireVisitorDownloadSlots({ ...guest, kind: 'video' })();
  });
});
