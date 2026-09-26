import { describe, expect, it } from 'vitest';
import { beginAttempt, getVisitorLogs, record } from '../../src/services/downloadLogs';

describe('downloadLogs', () => {
  it('lets the visitor who started an attempt read its log lines back', () => {
    beginAttempt({ requestId: 'r1', platform: 'youtube', mediaKey: 'abc123', guestId: 'guest-1' });
    record('r1', 'warn', 'live streaming failed, preparing instead');
    record('r1', 'info', 'download completed successfully.');

    const attempts = getVisitorLogs('youtube', 'abc123', 'guest-1', undefined);
    expect(attempts).toHaveLength(1);
    expect(attempts?.[0].requestId).toBe('r1');
    expect(attempts?.[0].lines.map((l) => l.message)).toEqual([
      'live streaming failed, preparing instead',
      'download completed successfully.',
    ]);
  });

  it('never shows one visitor another visitor\'s attempt', () => {
    beginAttempt({ requestId: 'r2', platform: 'youtube', mediaKey: 'other', guestId: 'guest-a' });
    record('r2', 'info', 'hello');
    expect(getVisitorLogs('youtube', 'other', 'guest-b', undefined)).toBeUndefined();
  });

  it('is a no-op to record against a requestId that was never registered', () => {
    expect(() => record('never-registered', 'error', 'x')).not.toThrow();
  });

  it('returns undefined for media nobody has ever attempted', () => {
    expect(getVisitorLogs('youtube', 'never-seen-media', 'guest-1', undefined)).toBeUndefined();
  });

  it('matches a logged-in user by userId even without a guestId', () => {
    beginAttempt({ requestId: 'r3', platform: 'youtube', mediaKey: 'user-media', userId: 'user-1' });
    record('r3', 'info', 'ok');
    expect(getVisitorLogs('youtube', 'user-media', undefined, 'user-1')).toHaveLength(1);
    expect(getVisitorLogs('youtube', 'user-media', 'some-guest', undefined)).toBeUndefined();
  });

  it('redacts anything that looks like an IPv4 or IPv6 address before storing a line', () => {
    beginAttempt({ requestId: 'r6', platform: 'youtube', mediaKey: 'ip-test', guestId: 'guest-ip' });
    record('r6', 'warn', 'upstream refused (203.0.113.42) and again from 2001:db8::1');
    const [line] = getVisitorLogs('youtube', 'ip-test', 'guest-ip', undefined)![0].lines;
    expect(line.message).toBe('upstream refused ([ip]) and again from [ip]');
  });

  it('returns the most recent attempt first', () => {
    beginAttempt({ requestId: 'r4', platform: 'youtube', mediaKey: 'multi', guestId: 'guest-multi' });
    beginAttempt({ requestId: 'r5', platform: 'youtube', mediaKey: 'multi', guestId: 'guest-multi' });
    const attempts = getVisitorLogs('youtube', 'multi', 'guest-multi', undefined);
    expect(attempts?.map((a) => a.requestId)).toEqual(['r5', 'r4']);
  });
});
