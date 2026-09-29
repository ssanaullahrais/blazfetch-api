import { env } from '../../config/env';
import { BlazfetchError } from '../../constants/errors';
import { fetchCobaltMetadata, downloadCobalt } from '../fallback/cobalt';
import { AdapterFetchContext, DownloadTarget, PlatformAdapter } from './types';

const recoverable = new Set(['EXTRACTOR_FAILED', 'PLATFORM_RATE_LIMITED', 'PROCESS_TIMEOUT', 'LOGIN_REQUIRED', 'DOWNLOAD_FAILED', 'FORMAT_UNAVAILABLE']);

export class ResilientAdapter implements PlatformAdapter {
  constructor(private readonly primary: PlatformAdapter) {}
  get platform() { return this.primary.platform; }
  supports: PlatformAdapter['supports'] = (url) => this.primary.supports(url);

  async fetchMetadata(ctx: AdapterFetchContext) {
    try { return await this.primary.fetchMetadata(ctx); }
    catch (error) {
      if (!this.canRecover(error) || (ctx.normalizedUrl.playlistId && !ctx.normalizedUrl.videoId)) throw error;
      try { return await fetchCobaltMetadata(ctx); } catch { throw error; }
    }
  }

  async download(ctx: AdapterFetchContext, target: DownloadTarget) {
    if (target.signal.aborted) throw new BlazfetchError('DOWNLOAD_FAILED', 'Request was cancelled.');
    if (target.formatId.startsWith('cobalt-')) return downloadCobalt(ctx, target.kind, target.signal);
    try { return await this.primary.download(ctx, target); }
    catch (error) {
      if (target.signal.aborted || !this.canRecover(error)) throw error;
      try { return await downloadCobalt(ctx, target.kind, target.signal); } catch { throw error; }
    }
  }

  private canRecover(error: unknown): boolean {
    return !!env.COBALT_API_URL && error instanceof BlazfetchError && recoverable.has(error.code);
  }
}
