import { getDb } from '../../db';
import { BlazfetchResponse } from '../../types/blazfetch';

export async function getCachedMetadata(platform: string, mediaId: string): Promise<BlazfetchResponse | null> {
  return getDb().metadataCache.get(platform, mediaId);
}

export async function getCachedMetadataByUrl(platform: string, canonicalUrl: string): Promise<BlazfetchResponse | null> {
  return getDb().metadataCache.getByUrl(platform, canonicalUrl);
}

export async function setCachedMetadata(
  platform: string,
  mediaId: string,
  canonicalUrl: string,
  metadata: BlazfetchResponse,
): Promise<void> {
  return getDb().metadataCache.set(platform, mediaId, canonicalUrl, metadata);
}
