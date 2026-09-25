import { describe, expect, it } from 'vitest';
import { ProgressTracker, parseProgressLine } from '../../src/core/ytdlp/ytdlpDownload';
import { parseFfmpegProgress } from '../../src/core/ffmpeg/ffmpegRunner';
import { parseByteRange } from '../../src/controllers/downloadController';

describe('parseProgressLine', () => {
  it('reads the progress template yt-dlp prints', () => {
    expect(parseProgressLine('BFPROG 512 1024 NA 137')).toEqual({ downloadedBytes: 512, totalBytes: 1024, formatId: '137' });
  });

  it('falls back to the estimated total, and treats NA as unknown', () => {
    expect(parseProgressLine('BFPROG 512 NA 2048.5 hls-720')).toEqual({ downloadedBytes: 512, totalBytes: 2048.5, formatId: 'hls-720' });
    expect(parseProgressLine('BFPROG NA NA NA 18')).toEqual({ downloadedBytes: 0, totalBytes: undefined, formatId: '18' });
  });

  it('ignores every other line (including the final file path)', () => {
    expect(parseProgressLine('/tmp/job/abc.mp4')).toBeNull();
    expect(parseProgressLine('[download] Destination: x.mp4')).toBeNull();
  });
});

describe('ProgressTracker', () => {
  it('counts a merged download (video, then audio) as one bar that never goes backwards', () => {
    const tracker = new ProgressTracker();
    expect(tracker.update({ downloadedBytes: 450, totalBytes: 900, formatId: '137' })).toBe(50);
    expect(tracker.update({ downloadedBytes: 900, totalBytes: 900, formatId: '137' })).toBe(99);
    // The audio part starts from zero; the bar holds instead of dropping back.
    expect(tracker.update({ downloadedBytes: 0, totalBytes: 100, formatId: '140' })).toBe(99);
    expect(tracker.update({ downloadedBytes: 100, totalBytes: 100, formatId: '140' })).toBe(99);
    expect(tracker.bytes).toBe(1000);
  });

  it('leaves room for the audio when the expected size of the whole download is known', () => {
    const tracker = new ProgressTracker(1000);
    expect(tracker.update({ downloadedBytes: 900, totalBytes: 900, formatId: '137' })).toBe(90);
    expect(tracker.update({ downloadedBytes: 50, totalBytes: 100, formatId: '140' })).toBe(95);
  });

  it('uses the bytes on disk when the downloader reports nothing, and only with an expected size', () => {
    expect(new ProgressTracker().updateFromDisk(500)).toBeUndefined();
    const tracker = new ProgressTracker(1000);
    expect(tracker.updateFromDisk(250)).toBe(25);
    expect(tracker.updateFromDisk(5000)).toBe(99);
  });
});

describe('parseFfmpegProgress', () => {
  it('turns out_time into a percentage of the duration', () => {
    expect(parseFfmpegProgress('out_time_us=30000000', 120)).toBe(25);
    expect(parseFfmpegProgress('out_time_ms=60000000', 120)).toBe(50);
    expect(parseFfmpegProgress('out_time_us=999000000', 120)).toBe(100);
  });

  it('ignores other keys and an unknown duration', () => {
    expect(parseFfmpegProgress('frame=100', 120)).toBeUndefined();
    expect(parseFfmpegProgress('out_time_us=1000', 0)).toBeUndefined();
  });
});

describe('parseByteRange', () => {
  it('sends the whole file without a (usable) Range header', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseByteRange('items=0-1', 100)).toBeNull();
  });

  it('resumes from an offset, and clamps the end to the file', () => {
    expect(parseByteRange('bytes=40-', 100)).toEqual({ start: 40, end: 99 });
    expect(parseByteRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 });
    expect(parseByteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });

  it('refuses a range outside the file', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=50-10', 100)).toBe('unsatisfiable');
  });
});
