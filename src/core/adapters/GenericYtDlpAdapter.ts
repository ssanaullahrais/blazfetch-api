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

    const { stdout, stderr, exitCode } = await runYtdlp({
      args: ['-J', '--no-warnings', '--no-playlist', targetUrl],
    });

    if (exitCode !== 0) {
      throw classifyYtdlpFailure(stderr);
    }

    let info: YtdlpRawInfo;
    try {
      info = JSON.parse(stdout);
    } catch {
      throw new BlazfetchError('EXTRACTOR_FAILED', 'Failed to parse extractor output.');
    }

    return normalizeYtdlpInfo(info, this.platform, targetUrl);
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    const targetUrl = ctx.normalizedUrl.canonicalUrl;
    await assertSafeTarget(targetUrl);

    const filePath = await downloadWithYtdlp({
      url: targetUrl,
      formatId: target.formatId,
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
