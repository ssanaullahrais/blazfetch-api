import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env';
import { ffmpegProxyEnvironment, withYtdlpRuntime } from '../../src/core/ytdlp/ytdlpArgs';

const originalProxy = env.YTDLP_PROXY_URL;

afterEach(() => {
  (env as { YTDLP_PROXY_URL: string }).YTDLP_PROXY_URL = originalProxy;
});

describe('yt-dlp shared arguments', () => {
  it('routes yt-dlp and ffmpeg through the configured media proxy', () => {
    (env as { YTDLP_PROXY_URL: string }).YTDLP_PROXY_URL = 'http://127.0.0.1:40128';

    expect(withYtdlpRuntime(['-J', 'https://example.com/video'])).toEqual(
      expect.arrayContaining(['--proxy', 'http://127.0.0.1:40128', '-J']),
    );
    expect(ffmpegProxyEnvironment()).toMatchObject({
      http_proxy: 'http://127.0.0.1:40128',
      https_proxy: 'http://127.0.0.1:40128',
      no_proxy: '127.0.0.1,localhost',
    });
  });
});
