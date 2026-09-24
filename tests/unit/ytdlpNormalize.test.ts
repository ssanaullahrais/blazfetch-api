import { describe, expect, it } from 'vitest';
import { normalizeFormats } from '../../src/core/adapters/ytdlpNormalize';

describe('normalizeFormats', () => {
  it('separates audio-only, video-only, and combined formats', () => {
    const { formats, audioFormats } = normalizeFormats([
      { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128 },
      { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920 },
      { format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, width: 640 },
      { format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, width: 1920 },
    ]);

    expect(audioFormats).toHaveLength(1);
    expect(audioFormats[0].formatId).toBe('140');

    expect(formats).toHaveLength(3);
    const videoOnly = formats.find((f) => f.formatId === '137');
    expect(videoOnly?.requiresMerge).toBe(true);
    expect(videoOnly?.compatible).toBe(true);

    const vp9 = formats.find((f) => f.formatId === '248');
    expect(vp9?.compatible).toBe(false);

    const combined = formats.find((f) => f.formatId === '18');
    expect(combined?.requiresMerge).toBe(false);
    expect(combined?.compatible).toBe(true);
  });
});
