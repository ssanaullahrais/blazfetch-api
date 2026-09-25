import { describe, expect, it } from 'vitest';
import { isManifestFormat, phoneSafeEquivalent, pickBestAudioFormat, pickBestVideoFormat } from '../../src/core/adapters/formatSelection';
import { BlazfetchAudioFormat, BlazfetchFormat } from '../../src/types/blazfetch';

describe('pickBestVideoFormat: prefers phone-safe H.264 from 720p up', () => {
  const f = (formatId: string, height: number, compatible: boolean, ext = 'mp4') => ({ formatId, ext, kind: 'video' as const, height, compatible });

  it('picks 1080p H.264 over 4K VP9 so no slow re-encode is needed', () => {
    expect(pickBestVideoFormat([f('vp9-4k', 2160, false), f('avc-1080', 1080, true), f('avc-360', 360, true)])?.formatId).toBe('avc-1080');
  });

  it('falls back to the sharpest format when H.264 only exists in low resolution', () => {
    expect(pickBestVideoFormat([f('vp9-1080', 1080, false), f('avc-480', 480, true)])?.formatId).toBe('vp9-1080');
  });
});

describe('pickBestVideoFormat', () => {
  it('picks the highest resolution, breaking ties on bitrate', () => {
    const formats: BlazfetchFormat[] = [
      { formatId: 'a', ext: 'mp4', kind: 'video', height: 360, bitrate: 500 },
      { formatId: 'b', ext: 'mp4', kind: 'video', height: 1080, bitrate: 3000 },
      { formatId: 'c', ext: 'mp4', kind: 'video', height: 1080, bitrate: 4500 },
      { formatId: 'd', ext: 'mp4', kind: 'video', height: 720, bitrate: 9000 },
    ];
    expect(pickBestVideoFormat(formats)?.formatId).toBe('c');
  });

  it('returns undefined for an empty list', () => {
    expect(pickBestVideoFormat([])).toBeUndefined();
  });
});

describe('pickBestAudioFormat', () => {
  it('picks the highest bitrate', () => {
    const formats: BlazfetchAudioFormat[] = [
      { formatId: 'a', ext: 'm4a', bitrate: 128, isConverted: false },
      { formatId: 'b', ext: 'm4a', bitrate: 256, isConverted: false },
      { formatId: 'c', ext: 'mp3', bitrate: 192, isConverted: true },
    ];
    expect(pickBestAudioFormat(formats)?.formatId).toBe('b');
  });

  it('prefers AAC over a WebM/Opus track of about the same bitrate, which phones may not play', () => {
    const youtube: BlazfetchAudioFormat[] = [
      { formatId: '251', ext: 'webm', codec: 'opus', bitrate: 135, isConverted: false },
      { formatId: '140', ext: 'm4a', codec: 'mp4a.40.2', bitrate: 129, isConverted: false },
      { formatId: '250', ext: 'webm', codec: 'opus', bitrate: 70, isConverted: false },
    ];
    expect(pickBestAudioFormat(youtube)?.formatId).toBe('140');
  });

  it('keeps a much better WebM track over a weak AAC one', () => {
    const formats: BlazfetchAudioFormat[] = [
      { formatId: 'opus', ext: 'webm', codec: 'opus', bitrate: 160, isConverted: false },
      { formatId: 'aac', ext: 'm4a', codec: 'mp4a.40.5', bitrate: 48, isConverted: false },
    ];
    expect(pickBestAudioFormat(formats)?.formatId).toBe('opus');
  });
});

describe('YouTube HLS copies and H.264 equivalents', () => {
  const hls = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1/id/x/file/index.m3u8';
  const plain = (itag: string) => `https://rr5.googlevideo.com/videoplayback?itag=${itag}`;
  const formats = [
    { formatId: '270', ext: 'mp4', kind: 'video_only', height: 1080, fps: 24, bitrate: 4687, compatible: true, requiresMerge: true, url: hls },
    { formatId: '137', ext: 'mp4', kind: 'video_only', height: 1080, fps: 24, bitrate: 2366, compatible: true, requiresMerge: true, url: plain('137') },
    { formatId: '248', ext: 'webm', kind: 'video_only', height: 1080, fps: 24, bitrate: 1500, compatible: false, requiresMerge: true, url: plain('248') },
    { formatId: '232', ext: 'mp4', kind: 'video_only', height: 720, fps: 24, bitrate: 2565, compatible: true, requiresMerge: true, url: hls },
    { formatId: '247', ext: 'webm', kind: 'video_only', height: 720, fps: 24, bitrate: 900, compatible: false, requiresMerge: true, url: plain('247') },
    { formatId: '136', ext: 'mp4', kind: 'video_only', height: 720, fps: 24, bitrate: 1200, compatible: true, requiresMerge: true, url: plain('136') },
    { formatId: '313', ext: 'webm', kind: 'video_only', height: 2160, fps: 24, bitrate: 9000, compatible: false, requiresMerge: true, url: plain('313') },
  ] as BlazfetchFormat[];
  const byId = (id: string) => formats.find((f) => f.formatId === id) as BlazfetchFormat;

  it('recognises manifest formats, including YouTube hls_playlist links without .m3u8', () => {
    expect(isManifestFormat(byId('270'))).toBe(true);
    expect(isManifestFormat({ formatId: 'x', url: 'https://cdn.example/a.m3u8?t=1' })).toBe(true);
    expect(isManifestFormat({ formatId: 'hls-720', url: undefined })).toBe(true);
    expect(isManifestFormat(byId('137'))).toBe(false);
  });

  it('"best" picks the plain H.264 file over its HLS copy with a higher listed bitrate', () => {
    expect(pickBestVideoFormat(formats.filter((f) => f.formatId !== '313'))?.formatId).toBe('137');
  });

  it('swaps a VP9 pick for the H.264 version of the same quality, so Compatible needs no re-encode', () => {
    expect(phoneSafeEquivalent(formats, byId('247'))?.formatId).toBe('136');
    expect(phoneSafeEquivalent(formats, byId('248'))?.formatId).toBe('137');
  });

  it('keeps the pick when it is already H.264, or when no H.264 version of that quality exists', () => {
    expect(phoneSafeEquivalent(formats, byId('136'))).toBeUndefined();
    expect(phoneSafeEquivalent(formats, byId('313'))).toBeUndefined();
  });
});
