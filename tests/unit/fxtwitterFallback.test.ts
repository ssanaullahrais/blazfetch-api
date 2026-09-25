import { describe, expect, it } from 'vitest';
import { tweetIdFromUrl } from '../../src/core/fallback/twitter/fxtwitterFallback';

describe('X fallback', () => {
  it('reads the post id from x.com and twitter.com links', () => {
    expect(tweetIdFromUrl('https://x.com/WowDvxx/status/2101871938142691537/video/1')).toBe('2101871938142691537');
    expect(tweetIdFromUrl('https://twitter.com/a/statuses/2101871938142691537')).toBe('2101871938142691537');
    expect(tweetIdFromUrl('https://x.com/WowDvxx')).toBeUndefined();
  });
});
