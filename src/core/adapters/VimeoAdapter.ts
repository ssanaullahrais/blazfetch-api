import fs from 'node:fs';
import path from 'node:path';
import mime from '../../lib/mime';
import { logger } from '../../lib/logger';
import { assertUrlIsSafeToFetch, NormalizedUrlResult } from '../../utils/url';
import { classifyYtdlpFailure, runYtdlp } from '../ytdlp/ytdlpRunner';
import { downloadWithYtdlp } from '../ytdlp/ytdlpDownload';
import { normalizeYtdlpInfo, YtdlpRawInfo } from './ytdlpNormalize';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { AdapterFetchContext, DownloadResult, DownloadTarget, PlatformAdapter } from './types';
import { BlazfetchError } from '../../constants/errors';
import { BlazfetchResponse } from '../../types/blazfetch';

function toPlayerUrl(canonicalUrl: string): string | null {
  const match = canonicalUrl.match(/vimeo\.com\/(\d+)/);
  return match ? `https://player.vimeo.com/video/${match[1]}` : null;
}

/**
 * Vimeo watch-page URLs sometimes fail anonymous extraction; retrying against the public
 * player/embed URL resolves most of those cases without needing a separate downloader.
 */
export class VimeoAdapter implements PlatformAdapter {
  readonly platform = 'vimeo' as const;
  private readonly delegate = new GenericYtDlpAdapter('vimeo');

  supports(normalizedUrl: NormalizedUrlResult): boolean {
    return normalizedUrl.platform === 'vimeo';
  }

  async fetchMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse> {
    try {
      return await this.delegate.fetchMetadata(ctx);
    } catch (err) {
      const playerUrl = toPlayerUrl(ctx.normalizedUrl.canonicalUrl);
      if (!playerUrl) throw err;

      await assertUrlIsSafeToFetch(playerUrl);
      const { stdout, stderr, exitCode } = await runYtdlp({ args: ['-J', '--no-warnings', playerUrl] });
      if (exitCode !== 0) throw classifyYtdlpFailure(stderr);

      let info: YtdlpRawInfo;
      try {
        info = JSON.parse(stdout);
      } catch {
        throw new BlazfetchError('EXTRACTOR_FAILED', 'Failed to parse extractor output.');
      }
      return normalizeYtdlpInfo(info, 'vimeo', ctx.normalizedUrl.canonicalUrl);
    }
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult> {
    try {
      return await this.delegate.download(ctx, target);
    } catch (err) {
      const playerUrl = toPlayerUrl(ctx.normalizedUrl.canonicalUrl);
      if (!playerUrl) throw err;

      logger.warn({ requestId: ctx.requestId, err: (err as Error).message }, 'yt-dlp download failed for Vimeo watch URL, retrying via player URL');
      await assertUrlIsSafeToFetch(playerUrl);

      const filePath = await downloadWithYtdlp({
        url: playerUrl,
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
}
