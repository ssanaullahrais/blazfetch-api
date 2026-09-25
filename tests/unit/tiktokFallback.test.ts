import { describe, expect, it } from 'vitest';
import { linkFrom } from '../../src/core/fallback/tiktok/tobyg74Adapter';

describe('linkFrom (TikTok fallback provider values)', () => {
  it('reads a plain link, a list of links, and the objects current releases return', () => {
    expect(linkFrom('https://v16.tiktokcdn.com/a.mp4')).toBe('https://v16.tiktokcdn.com/a.mp4');
    expect(linkFrom(['https://v16.tiktokcdn.com/a.mp4', 'https://v19.tiktokcdn.com/a.mp4'])).toBe('https://v16.tiktokcdn.com/a.mp4');
    expect(linkFrom({ ratio: '540p', duration: 10542, playAddr: ['https://v16.tiktokcdn.com/v.mp4'] })).toBe('https://v16.tiktokcdn.com/v.mp4');
    expect(linkFrom({ id: 1, title: 'original sound', playUrl: ['https://v16.tiktokcdn.com/m.mp3'] })).toBe('https://v16.tiktokcdn.com/m.mp3');
    expect(linkFrom({ url_list: ['https://p16.tiktokcdn.com/c.jpg'] })).toBe('https://p16.tiktokcdn.com/c.jpg');
  });

  it('ignores anything that is not an http(s) link', () => {
    expect(linkFrom(undefined)).toBeUndefined();
    expect(linkFrom({ ratio: '540p' })).toBeUndefined();
    expect(linkFrom('javascript:alert(1)')).toBeUndefined();
    expect(linkFrom(['file:///etc/passwd'])).toBeUndefined();
  });
});
