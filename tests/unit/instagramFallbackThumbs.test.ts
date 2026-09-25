import { describe, expect, it } from 'vitest';
import { InstagramAdapter } from '../../src/core/adapters/InstagramAdapter';

type Raw = { url: string; type: 'image' | 'video'; thumbnail?: string };
const normalize = (raw: Raw[]) =>
  (new InstagramAdapter() as unknown as { normalizeFallbackItems(r: Raw[], u: string, f: string): { items?: { type: string; thumbnail?: string }[] } })
    .normalizeFallbackItems(raw, 'https://www.instagram.com/someone', 'btch-downloader');

describe('Instagram fallback items', () => {
  it('does not repeat one shared thumbnail on every item of a profile', () => {
    const shared = 'https://cdn.example.com/cover.jpg';
    const { items } = normalize([
      { url: 'https://d.example.com/a.mp4', type: 'video', thumbnail: shared },
      { url: 'https://d.example.com/b.jpg', type: 'image', thumbnail: shared },
      { url: 'https://d.example.com/c.mp4', type: 'video', thumbnail: shared },
    ]);
    expect(items?.map((i) => i.thumbnail)).toEqual([undefined, 'https://d.example.com/b.jpg', undefined]);
  });

  it('keeps distinct thumbnails when the provider sends them', () => {
    const { items } = normalize([
      { url: 'https://d.example.com/a.mp4', type: 'video', thumbnail: 'https://cdn.example.com/1.jpg' },
      { url: 'https://d.example.com/b.mp4', type: 'video', thumbnail: 'https://cdn.example.com/2.jpg' },
    ]);
    expect(items?.map((i) => i.thumbnail)).toEqual(['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg']);
  });
});

describe('Instagram fallback naming', () => {
  const run = (url: string) =>
    (new InstagramAdapter() as unknown as { normalizeFallbackItems(r: Raw[], u: string, f: string): { mediaId: string; title?: string; author?: { name?: string } } }).normalizeFallbackItems(
      [
        { url: 'https://d.example.com/a.mp4', type: 'video' },
        { url: 'https://d.example.com/b.jpg', type: 'image' },
      ],
      url,
      'btch-downloader',
    );

  it('names a profile after the account and keeps stories under a separate id', () => {
    expect(run('https://www.instagram.com/ajaydevgn')).toMatchObject({ mediaId: 'ajaydevgn', title: '@ajaydevgn', author: { name: '@ajaydevgn' } });
    expect(run('https://www.instagram.com/stories/ajaydevgn')).toMatchObject({ mediaId: 'stories-ajaydevgn', title: '@ajaydevgn · Stories' });
  });

  it('leaves a single post without an account title', () => {
    expect(run('https://www.instagram.com/p/DdtviT1KYcv').title).toBeUndefined();
  });
});
