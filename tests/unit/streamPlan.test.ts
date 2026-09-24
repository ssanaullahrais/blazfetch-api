import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildFilename, planStream, waitForFirstChunk } from '../../src/services/streamService';
import { ffmpegStreamArgs } from '../../src/core/ytdlp/ytdlpStream';
import type { BlazfetchResponse } from '../../src/types/blazfetch';

function media(overrides: Partial<BlazfetchResponse> = {}): BlazfetchResponse {
  return {
    success: true,
    platform: 'youtube',
    mediaType: 'video',
    mediaId: 'abc123',
    canonicalUrl: 'https://www.youtube.com/watch?v=abc123',
    title: 'My: Video/Title',
    formats: [
      { formatId: '18', ext: 'mp4', kind: 'video', height: 360, filesizeBytes: 1000 },
      { formatId: '137', ext: 'mp4', kind: 'video_only', height: 1080, requiresMerge: true },
      { formatId: 'hls-720', ext: 'mp4', kind: 'video', height: 720, url: 'https://cdn.example/a.m3u8?x=1' },
      { formatId: 'direct', ext: 'mp4', kind: 'video', height: 480, url: 'https://cdn.example/a.mp4' },
    ],
    audioFormats: [{ formatId: '140', ext: 'm4a', bitrate: 128, isConverted: false }],
    extractor: 'yt-dlp',
    ...overrides,
  } as BlazfetchResponse;
}

describe('planStream', () => {
  it('pipes a single-file format straight from yt-dlp with its exact size', () => {
    const plan = planStream(media(), { formatId: '18', kind: 'video' });
    expect(plan).toMatchObject({ type: 'ytdlp', selector: '18', contentType: 'video/mp4', ext: 'mp4', contentLength: 1000 });
  });

  it('refuses to stream a live merge (fragmented MP4 goes black on phones), so auto prepares it', () => {
    expect(() => planStream(media(), { formatId: '137', kind: 'video' })).toThrowError(/would not play on phones/);
  });

  it('refuses to stream HLS through a live remux for the same reason', () => {
    expect(() => planStream(media(), { formatId: 'hls-720', kind: 'video' })).toThrowError(/would not play on phones/);
  });

  it('refuses formats phones cannot play as-is (VP9/AV1/HEVC, WebM)', () => {
    const codecs = media({
      formats: [
        { formatId: 'vp9', ext: 'mp4', kind: 'video', codec: 'vp09.00.40.08' },
        { formatId: 'av1', ext: 'mp4', kind: 'video', codec: 'av01.0.08M.08' },
        { formatId: 'webm', ext: 'webm', kind: 'video', codec: 'avc1.64001f' },
        { formatId: 'h264', ext: 'mp4', kind: 'video', codec: 'avc1.64001f' },
      ],
    });
    for (const id of ['vp9', 'av1', 'webm']) expect(() => planStream(codecs, { formatId: id, kind: 'video' })).toThrowError(/would not play on phones/);
    expect(planStream(codecs, { formatId: 'h264', kind: 'video' })).toMatchObject({ type: 'ytdlp' });
  });

  it('pipes a real audio track as-is', () => {
    expect(planStream(media(), { formatId: '140', kind: 'audio' })).toMatchObject({ type: 'ytdlp', contentType: 'audio/mp4', ext: 'm4a' });
  });

  it('extracts MP3 through ffmpeg when there is no standalone audio', () => {
    const plan = planStream(media({ audioFormats: [] }), { formatId: 'mp3-from-18', kind: 'audio' });
    expect(plan).toMatchObject({ type: 'ffmpeg', mode: 'mp3', contentType: 'audio/mpeg', ext: 'mp3' });
  });

  it('proxies the direct URL for non-yt-dlp fallback providers', () => {
    const plan = planStream(media({ extractor: 'btch-downloader' }), { formatId: 'direct', kind: 'video' });
    expect(plan).toMatchObject({ type: 'proxy', url: 'https://cdn.example/a.mp4' });
  });

  it('rejects an unknown format', () => {
    expect(() => planStream(media(), { formatId: 'nope', kind: 'video' })).toThrowError(/not available/);
  });
});

describe('planStream: carousel items', () => {
  it('streams a video that lives inside a mixed photo + video carousel from its own link', () => {
    const carousel = media({
      extractor: 'fallback',
      formats: [],
      items: [
        { id: '0', type: 'image', source: 'https://cdn.example/a.jpg' },
        { id: '1', type: 'video', formats: [{ formatId: 'btch-downloader-1', ext: 'mp4', kind: 'video', url: 'https://cdn.example/v.mp4' }] },
      ],
    } as never);
    expect(planStream(carousel, { formatId: 'btch-downloader-1', kind: 'video' })).toMatchObject({ type: 'proxy', url: 'https://cdn.example/v.mp4', ext: 'mp4' });
  });
});

describe('planStream fast path', () => {
  const withUrls = media({
    formats: [
      { formatId: '137', ext: 'mp4', kind: 'video_only', height: 1080, requiresMerge: true, url: 'https://cdn.example/v.mp4' },
      { formatId: '18', ext: 'mp4', kind: 'video', height: 360, url: 'https://cdn.example/18.mp4' },
      { formatId: '43', ext: 'webm', kind: 'video', height: 360, url: 'https://cdn.example/43.webm' },
    ],
    audioFormats: [
      { formatId: '251', ext: 'webm', bitrate: 160, codec: 'opus', isConverted: false, url: 'https://cdn.example/opus.webm' },
      { formatId: '140', ext: 'm4a', bitrate: 128, codec: 'mp4a.40.2', isConverted: false, url: 'https://cdn.example/aac.m4a' },
    ],
  });

  it('passes a plain H.264 MP4 through untouched (no ffmpeg)', () => {
    expect(planStream(withUrls, { formatId: '18', kind: 'video' })).toMatchObject({ type: 'ytdlp', fast: { kind: 'proxy', url: 'https://cdn.example/18.mp4' } });
  });

  it('does not stream a WebM or a video-only format, which would not play on phones', () => {
    expect(() => planStream(withUrls, { formatId: '43', kind: 'video' })).toThrowError(/would not play on phones/);
    expect(() => planStream(withUrls, { formatId: '137', kind: 'video' })).toThrowError(/would not play on phones/);
  });

  it('passes a standalone audio track through untouched from its cached URL', () => {
    expect(planStream(withUrls, { formatId: '140', kind: 'audio' })).toMatchObject({ type: 'ytdlp', ext: 'm4a', fast: { kind: 'proxy', url: 'https://cdn.example/aac.m4a' } });
  });

  it('never passes an HLS/DASH manifest through as if it were the media', () => {
    const hlsAudio = media({ audioFormats: [{ formatId: 'hls_mp3', ext: 'mp3', bitrate: 128, isConverted: false, url: 'https://cdn.example/playlist.m3u8?x=1' }] });
    expect((planStream(hlsAudio, { formatId: 'hls_mp3', kind: 'audio' }) as { fast?: unknown }).fast).toBeUndefined();
  });

  it('has no fast path when the cached format has no URL', () => {
    expect((planStream(media(), { formatId: '18', kind: 'video' }) as { fast?: unknown }).fast).toBeUndefined();
  });
});

describe('ffmpegStreamArgs', () => {
  const inputs = [
    { url: 'https://cdn.example/v.mp4', headers: { 'User-Agent': 'UA' } },
    { url: 'https://cdn.example/a.m4a', headers: {} },
  ];

  it('writes fragmented MP4 to a pipe without transcoding', () => {
    const args = ffmpegStreamArgs(inputs, 'merge');
    expect(args).toContain('pipe:1');
    expect(args.join(' ')).toContain('frag_keyframe+empty_moov+default_base_moof');
    expect(args).toContain('copy');
    expect(args.join(' ')).not.toMatch(/libx264|libmp3lame/);
    expect(args.join(' ')).toContain('User-Agent: UA');
  });

  it('converts ADTS AAC for HLS inputs so the MP4 muxer does not abort', () => {
    const args = ffmpegStreamArgs([{ url: 'https://cdn.example/index.m3u8?sig=1', headers: {} }], 'remux');
    expect(args.join(' ')).toContain('-bsf:a aac_adtstoasc');
    expect(ffmpegStreamArgs([inputs[0]], 'remux').join(' ')).not.toContain('aac_adtstoasc');
  });

  it('extracts MP3 to a pipe', () => {
    const args = ffmpegStreamArgs([inputs[0]], 'mp3');
    expect(args).toEqual(expect.arrayContaining(['-vn', 'libmp3lame', 'mp3', 'pipe:1']));
  });
});

describe('buildFilename', () => {
  it('sanitizes the title and appends the extension', () => {
    expect(buildFilename(undefined, media(), 'mp4')).toBe('My_ Video_Title.mp4');
  });

  it('honours a requested filename without doubling the extension', () => {
    expect(buildFilename('clip.mp4', media(), 'mp4')).toBe('clip.mp4');
    expect(buildFilename('../../etc/passwd', media(), 'mp4')).not.toContain('/');
  });
});

describe('waitForFirstChunk', () => {
  it('resolves with the first chunk and pauses the stream', async () => {
    const s = new PassThrough();
    const p = waitForFirstChunk(s);
    s.write(Buffer.from('hello'));
    expect((await p).toString()).toBe('hello');
    expect(s.isPaused()).toBe(true);
  });

  it('rejects when the stream errors before any data', async () => {
    const s = new PassThrough();
    const p = waitForFirstChunk(s);
    s.destroy(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
  });

  it('rejects when the stream ends without data', async () => {
    const s = new PassThrough();
    const p = waitForFirstChunk(s);
    s.end();
    await expect(p).rejects.toThrow(/no data/);
  });
});
