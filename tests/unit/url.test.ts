import { describe, expect, it } from 'vitest';
import { validateAndNormalizeUrl } from '../../src/utils/url';
import { BlazfetchError } from '../../src/constants/errors';

describe('validateAndNormalizeUrl', () => {
  it('normalizes youtu.be short links to the canonical watch URL', () => {
    const result = validateAndNormalizeUrl('https://youtu.be/dQw4w9WgXcQ');
    expect(result.platform).toBe('youtube');
    expect(result.canonicalUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result.videoId).toBe('dQw4w9WgXcQ');
  });

  it('normalizes YouTube shorts URLs', () => {
    const result = validateAndNormalizeUrl('https://www.youtube.com/shorts/abc123');
    expect(result.canonicalUrl).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('strips tracking parameters', () => {
    const result = validateAndNormalizeUrl('https://www.youtube.com/watch?v=abc123&utm_source=twitter&si=xyz');
    expect(result.canonicalUrl).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('adds https:// when the protocol is missing', () => {
    const result = validateAndNormalizeUrl('www.tiktok.com/@user/video/123');
    expect(result.platform).toBe('tiktok');
  });

  it('matches subdomains against the whitelist', () => {
    const result = validateAndNormalizeUrl('https://m.youtube.com/watch?v=abc123');
    expect(result.platform).toBe('youtube');
  });

  it('rejects unsupported platforms', () => {
    expect(() => validateAndNormalizeUrl('https://example.com/video/1')).toThrow(BlazfetchError);
  });

  it('rejects malformed URLs', () => {
    expect(() => validateAndNormalizeUrl('not a url at all::::')).toThrow(BlazfetchError);
  });

  it('rejects disallowed protocols', () => {
    expect(() => validateAndNormalizeUrl('file:///etc/passwd')).toThrow(BlazfetchError);
  });

  it('normalizes Instagram host variants', () => {
    const result = validateAndNormalizeUrl('https://instagr.am/p/abc123/');
    expect(result.canonicalUrl).toBe('https://www.instagram.com/p/abc123');
  });

  it('normalizes a single SoundCloud track URL', () => {
    const result = validateAndNormalizeUrl('https://soundcloud.com/nasa/houston-we-have-a-podcast-4');
    expect(result.platform).toBe('soundcloud');
    expect(result.canonicalUrl).toBe('https://soundcloud.com/nasa/houston-we-have-a-podcast-4');
  });

  it('rejects a bare SoundCloud profile URL rather than enumerating the whole channel', () => {
    expect(() => validateAndNormalizeUrl('https://soundcloud.com/nasa')).toThrow(BlazfetchError);
  });

  it('rejects SoundCloud browse pages like /you or /discover', () => {
    expect(() => validateAndNormalizeUrl('https://soundcloud.com/discover')).toThrow(BlazfetchError);
  });
});
