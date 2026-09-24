import { describe, expect, it } from 'vitest';
import { pickBestAudioFormat, pickBestVideoFormat } from '../../src/core/adapters/formatSelection';
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
});
