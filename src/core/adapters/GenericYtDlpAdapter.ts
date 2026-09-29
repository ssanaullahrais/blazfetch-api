import fs from 'node:fs';
import path from 'node:path';
import mime from '../../lib/mime';
import { PlatformId } from '../../constants/platforms';
import { BlazfetchError } from '../../constants/errors';
import { NormalizedUrlResult } from '../../utils/url';
import { assertUrlIsSafeToFetch } from '../../utils/url';
import { isOpenShortLink } from '../../utils/shortLinks';
import { classifyYtdlpFailure, runYtdlp } from '../ytdlp/ytdlpRunner';
import { downloadWithYtdlp } from '../ytdlp/ytdlpDownload';
import { normalizeYtdlpInfo, YtdlpRawInfo } from './ytdlpNormalize';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchResponse } from '../../types/blazfetch';

/** yt-dlp follows redirects without the SSRF checks, so an unresolved open short link (t.co) must never reach it. */
async function assertSafeTarget(targetUrl: string): Promise<void> {
  if (isOpenShortLink(targetUrl)) throw new BlazfetchError('INVALID_URL', 'This short link could not be resolved.');
  await assertUrlIsSafeToFetch(targetUrl);
}

/**
 * Default adapter for every platform that yt-dlp supports natively with no platform-specific
 * quirks. Platform adapters with special handling (playlists, carousels, fallbacks) compose or
 * extend this rather than duplicating the yt-dlp invocation logic.
 */
export class GenericYtDlpAdapter implements PlatformAdapter {
  constructor(public readonly platform: PlatformId) {}

  supports(normalizedUrl: NormalizedUrlResult): boolean {
    return normalizedUrl.platform === this.platform;
  }

  async fetchMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    const targetUrl = ctx.normalizedUrl.canonicalUrl;
    await assertSafeTarget(targetUrl);

    let result;
    let genericFallback = false;
    try {
      result = await runYtdlp({ args: ['-J', '--no-warnings', '--no-playlist', targetUrl] });
      if (result.exitCode !== 0) throw classifyYtdlpFailure(result.stderr);
    } catch (error) {
      // Tumblr's dedicated extractor calls its login/iframe host even for public HTML5 video.
      // Retry only transient failures, never private/deleted/restricted media.
      if (this.platform !== 'tumblr' || !(error instanceof BlazfetchError) || !['PROCESS_TIMEOUT', 'EXTRACTOR_FAILED', 'PLATFORM_RATE_LIMITED'].includes(error.code)) throw error;
      try {
        result = await runYtdlp({ args: ['-J', '--no-warnings', '--no-playlist', '--force-generic-extractor', targetUrl] });
        if (result.exitCode !== 0) throw classifyYtdlpFailure(result.stderr);
        genericFallback = true;
      } catch { throw error; }
    }

    let info: YtdlpRawInfo;
    try {
      info = JSON.parse(result.stdout);
    } catch {
      throw new BlazfetchError('EXTRACTOR_FAILED', 'Failed to parse extractor output.');
    }

    const response = normalizeYtdlpInfo(info, this.platform, targetUrl);
    if (genericFallback) {
      response.mediaId = new URL(targetUrl).pathname.match(/\/(?:post|video)\/(\d+)/)?.[1] ?? response.mediaId;
      response.fallbackUsed = 'yt-dlp-generic';
      for (const format of [...response.formats, ...response.audioFormats]) format.formatId = `tumblr-generic-${format.formatId}`;
    }
    return response;
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    const targetUrl = ctx.normalizedUrl.canonicalUrl;
    await assertSafeTarget(targetUrl);

    const filePath = await downloadWithYtdlp({
      url: targetUrl,
      formatId: this.platform === 'tumblr' ? target.formatId.replace(/^tumblr-generic-/, '') : target.formatId,
      forceGenericExtractor: this.platform === 'tumblr' && target.formatId.startsWith('tumblr-generic-'),
      outputDir: target.outputDir,
      signal: target.signal,
      onProgress: target.onProgress,
      expectedBytes: target.expectedBytes,
    });

    const stat = await fs.promises.stat(filePath);
    return {
      filePath,
      filename: path.basename(filePath),
      mimeType: mime.lookup(filePath) || 'application/octet-stream',
      bytes: stat.size,
    };
  }
}
