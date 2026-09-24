import { describe, expect, it } from 'vitest';
import { fallbackItemKey, fallbackItemType } from '../../src/core/adapters/InstagramAdapter';

const token = (payload: object): string => `https://d.rapidcdn.app/v2?token=h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('fallbackItemType', () => {
  it('reads photos and videos from the provider token, since the link itself has no extension', () => {
    expect(fallbackItemType(token({ url: 'https://scontent.cdninstagram.com/v/a_n.jpg?x=1', filename: 'a.jpg' }))).toBe('image');
    expect(fallbackItemType(token({ url: 'https://scontent.cdninstagram.com/o1/v/b.mp4?x=1', filename: 'b.mp4' }))).toBe('video');
  });

  it('falls back to the plain link extension', () => {
    expect(fallbackItemType('https://cdn.example/a.mp4?x=1')).toBe('video');
    expect(fallbackItemType('https://cdn.example/a.jpg')).toBe('image');
    expect(fallbackItemType('https://d.rapidcdn.app/v2?token=garbage')).toBe('image');
  });
});

describe('fallbackItemKey', () => {
  it('gives the same key to repeated entries for one photo', () => {
    const a = token({ url: 'https://scontent.cdninstagram.com/v/a_n.jpg?x=1' });
    const b = token({ url: 'https://scontent.cdninstagram.com/v/a_n.jpg?x=2', filename: 'other' });
    expect(fallbackItemKey(a)).toBe(fallbackItemKey(b));
    expect(fallbackItemKey(token({ url: 'https://scontent.cdninstagram.com/v/z_n.jpg' }))).not.toBe(fallbackItemKey(a));
  });
});
