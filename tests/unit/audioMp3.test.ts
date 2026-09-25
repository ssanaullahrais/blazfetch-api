import { describe, expect, it, vi } from 'vitest';

const flag = vi.hoisted(() => ({ on: true }));
vi.mock('../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/env')>('../../src/config/env');
  return { ...actual, env: new Proxy(actual.env, { get: (target, key) => (key === 'AUDIO_FORCE_MP3' ? flag.on : Reflect.get(target, key)) }) };
});

import { needsMp3Conversion, presentAudioFormats } from '../../src/utils/audioMp3';
import { planStream } from '../../src/services/streamService';
import type { BlazfetchResponse } from '../../src/types/blazfetch';

const media = {
  extractor: 'yt-dlp',
  formats: [],
  audioFormats: [
    { formatId: '140', ext: 'm4a', bitrate: 131, isConverted: false, url: 'https://cdn.example.com/a.m4a', filesizeBytes: 1000 },
    { formatId: 'mp3src', ext: 'mp3', bitrate: 128, isConverted: false, url: 'https://cdn.example.com/a.mp3' },
  ],
} as unknown as BlazfetchResponse;

describe('AUDIO_FORCE_MP3', () => {
  it('lists every audio option as MP3 and keeps the ids', () => {
    flag.on = true;
    const shown = presentAudioFormats(media.audioFormats, 100);
    expect(shown.map((f) => [f.formatId, f.ext, f.isConverted])).toEqual([
      ['140', 'mp3', true],
      ['mp3src', 'mp3', false],
    ]);
    // 100 s at 192 kbps: an approximate size, so the row shows one
    expect(shown[0]).toMatchObject({ filesizeBytes: 2_400_000, filesizeApprox: true });
  });

  it('plans a live ffmpeg MP3 conversion for a non-MP3 track, and passes an MP3 through', () => {
    flag.on = true;
    expect(planStream(media, { formatId: '140', kind: 'audio' })).toMatchObject({ type: 'ffmpeg', mode: 'mp3', ext: 'mp3', contentType: 'audio/mpeg' });
    expect(planStream(media, { formatId: 'mp3src', kind: 'audio' })).toMatchObject({ type: 'ytdlp', ext: 'mp3' });
  });

  it('changes nothing when the switch is off', () => {
    flag.on = false;
    expect(needsMp3Conversion({ ext: 'm4a' })).toBe(false);
    expect(presentAudioFormats(media.audioFormats)).toBe(media.audioFormats);
    expect(planStream(media, { formatId: '140', kind: 'audio' })).toMatchObject({ type: 'ytdlp', ext: 'm4a' });
  });
});
