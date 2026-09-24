import { describe, expect, it } from 'vitest';
import {
  buildMediaPath,
  idOfKey,
  isMixPlaylist,
  kindOfKey,
  mediaKeyForResponse,
  parseMediaPath,
  playlistKey,
  predictedMediaKey,
  sourceUrlForKey,
} from '../../src/core/media/mediaPath';
import { validateAndNormalizeUrl } from '../../src/utils/url';

describe('media keys and paths', () => {
  it('builds item and playlist paths', () => {
    expect(buildMediaPath('youtube', 'Cwkej79U3ek')).toBe('/youtube/Cwkej79U3ek');
    expect(buildMediaPath('youtube', playlistKey('RDCwkej79U3ek'), 'Cwkej79U3ek')).toBe('/youtube/Cwkej79U3ek/playlist/RDCwkej79U3ek');
    expect(buildMediaPath('youtube', playlistKey('PL1'))).toBe('/youtube/playlist/PL1');
  });

  it('parses every path form back to the same key', () => {
    expect(parseMediaPath('/youtube/Cwkej79U3ek')).toEqual({ platform: 'youtube', mediaKey: 'Cwkej79U3ek' });
    expect(parseMediaPath('/youtube/Cwkej79U3ek/playlist/RDCwkej79U3ek')).toEqual({
      platform: 'youtube',
      mediaKey: 'playlist:RDCwkej79U3ek',
      contextItemId: 'Cwkej79U3ek',
    });
    expect(parseMediaPath('/youtube/playlist/PL1')).toEqual({ platform: 'youtube', mediaKey: 'playlist:PL1' });
    expect(parseMediaPath('youtube/abc/')).toEqual({ platform: 'youtube', mediaKey: 'abc' });
  });

  it('round-trips ids that need URL encoding', () => {
    const key = 'weird id/with?chars';
    expect(parseMediaPath(buildMediaPath('tiktok', key))).toEqual({ platform: 'tiktok', mediaKey: key });
  });

  it('rejects unknown platforms, missing ids and malformed paths', () => {
    expect(parseMediaPath('/nowhere/abc')).toBeNull();
    expect(parseMediaPath('/youtube')).toBeNull();
    expect(parseMediaPath('/youtube/a/b/c/d')).toBeNull();
    expect(parseMediaPath('/youtube/playlist')).toBeNull();
    expect(parseMediaPath('/youtube/%E0%A4%A')).toBeNull();
  });

  it('predicts the storage key from a YouTube URL, including v= with list=', () => {
    expect(predictedMediaKey(validateAndNormalizeUrl('https://www.youtube.com/watch?v=Cwkej79U3ek&list=RDCwkej79U3ek'))).toBe('Cwkej79U3ek');
    expect(predictedMediaKey(validateAndNormalizeUrl('https://youtu.be/Cwkej79U3ek'))).toBe('Cwkej79U3ek');
    expect(predictedMediaKey(validateAndNormalizeUrl('https://www.youtube.com/playlist?list=PL1'))).toBe('playlist:PL1');
    expect(predictedMediaKey(validateAndNormalizeUrl('https://vimeo.com/76979871'))).toBeUndefined();
  });

  it('derives the key from a response and tells items, playlists and Mixes apart', () => {
    expect(mediaKeyForResponse({ mediaId: 'abc', mediaType: 'video' })).toBe('abc');
    expect(mediaKeyForResponse({ mediaId: 'PL1', mediaType: 'playlist', isPlaylist: true })).toBe('playlist:PL1');
    expect(kindOfKey('playlist:PL1')).toBe('playlist');
    expect(idOfKey('playlist:PL1')).toBe('PL1');
    expect(isMixPlaylist('youtube', 'playlist:RDabc')).toBe(true);
    expect(isMixPlaylist('youtube', 'playlist:PLabc')).toBe(false);
  });

  it('rebuilds fetchable source URLs where the id alone is enough', () => {
    expect(sourceUrlForKey('youtube', 'Cwkej79U3ek')).toBe('https://www.youtube.com/watch?v=Cwkej79U3ek');
    expect(sourceUrlForKey('youtube', 'playlist:PL1')).toBe('https://www.youtube.com/playlist?list=PL1');
    expect(sourceUrlForKey('vimeo', '76979871')).toBe('https://vimeo.com/76979871');
    expect(sourceUrlForKey('twitter', '123')).toBe('https://x.com/i/status/123');
    expect(sourceUrlForKey('instagram', 'DZYvGYIv1nr')).toBe('https://www.instagram.com/p/DZYvGYIv1nr/');
    // Not rebuildable from the id alone
    expect(sourceUrlForKey('bluesky', 'abc')).toBeUndefined();
    expect(sourceUrlForKey('reddit', 'abc')).toBeUndefined();
    expect(sourceUrlForKey('vimeo', 'not-a-number')).toBeUndefined();
  });

  it('every rebuilt URL is accepted by the URL validator and maps back to the same platform', () => {
    const samples: [string, string][] = [
      ['youtube', 'Cwkej79U3ek'],
      ['vimeo', '76979871'],
      ['dailymotion', 'x84sh87'],
      ['twitch', '2702797838'],
      ['streamable', 'hn8hq'],
      ['loom', '9245fa69349d4dfa8a8ade8b728ce1f6'],
      ['newgrounds', '921925'],
      ['pinterest', '550213279492193633'],
      ['rutube', 'caafe83ff1c6ed38d394635b83ece578'],
      ['instagram', 'DZYvGYIv1nr'],
      ['twitter', '1354143047324299264'],
      ['tiktok', '6718335390845095173'],
      ['facebook', '1097374499488415'],
      ['snapchat', 'W7_EDlXW'],
      ['soundcloud', '163684297'],
    ];
    for (const [platform, id] of samples) {
      const url = sourceUrlForKey(platform, id);
      expect(url, `${platform} url`).toBeTruthy();
      expect(validateAndNormalizeUrl(url as string).platform, `${platform} platform`).toBe(platform);
    }
  });
});
