import { PlatformId } from '../../constants/platforms';
import { NormalizedUrlResult } from '../../utils/url';
import { BlazfetchResponse } from '../../types/blazfetch';

export interface AdapterFetchContext {
  requestId: string;
  normalizedUrl: NormalizedUrlResult;
  /** 1-based, inclusive item range for collection URLs (Pinterest boards, etc). Ignored by
   *  adapters that don't support ranged collections. */
  range?: { start?: number; end?: number };
}

export interface DownloadTarget {
  /** Internal format identifier previously returned by fetchMetadata/fetchFormats — never raw shell args. */
  formatId: string;
  kind: 'video' | 'audio';
  outputDir: string;
  onProgress?: (progress: DownloadProgress) => void;
  /** Rough size of the finished file when known, so progress can be shown even when the downloader reports none. */
  expectedBytes?: number;
  signal: AbortSignal;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  speedBytesPerSec?: number;
  etaSeconds?: number;
}

export interface DownloadResult {
  filePath: string;
  filename: string;
  mimeType: string;
  bytes: number;
  /** True when the backend can hand the client a direct CDN URL instead of proxying the file. */
  directUrl?: string;
}

/**
 * Every platform integration implements this interface so the rest of the application
 * never depends on yt-dlp-specific or provider-specific response shapes.
 */
export interface PlatformAdapter {
  readonly platform: PlatformId;

  supports(normalizedUrl: NormalizedUrlResult): boolean;

  fetchMetadata(ctx: AdapterFetchContext): Promise<BlazfetchResponse>;

  download(ctx: AdapterFetchContext, target: DownloadTarget): Promise<DownloadResult>;
}
