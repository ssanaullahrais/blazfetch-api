import { pool } from '../../db/pool';
import { env } from '../../config/env';
import { BlazfetchResponse } from '../../types/blazfetch';

export async function getCachedMetadata(platform: string, mediaId: string): Promise<BlazfetchResponse | null> {
  const { rows } = await pool.query<{ metadata: BlazfetchResponse; expires_at: Date }>(
    `SELECT metadata, expires_at FROM metadata_cache WHERE platform = $1 AND media_id = $2`,
    [platform, mediaId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() < Date.now()) return null;
  return row.metadata;
}

export async function getCachedMetadataByUrl(platform: string, canonicalUrl: string): Promise<BlazfetchResponse | null> {
  const { rows } = await pool.query<{ metadata: BlazfetchResponse; expires_at: Date }>(
    `SELECT metadata, expires_at FROM metadata_cache WHERE platform = $1 AND canonical_url = $2 ORDER BY last_fetched_at DESC LIMIT 1`,
    [platform, canonicalUrl],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() < Date.now()) return null;
  return row.metadata;
}

export async function setCachedMetadata(
  platform: string,
  mediaId: string,
  canonicalUrl: string,
  metadata: BlazfetchResponse,
): Promise<void> {
  const expiresAt = new Date(Date.now() + env.CACHE_TTL_SECONDS * 1000);
  await pool.query(
    `INSERT INTO metadata_cache (platform, media_id, canonical_url, metadata, thumbnail, formats, audio_formats, last_fetched_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
     ON CONFLICT (platform, media_id) DO UPDATE SET
       canonical_url = EXCLUDED.canonical_url,
       metadata = EXCLUDED.metadata,
       thumbnail = EXCLUDED.thumbnail,
       formats = EXCLUDED.formats,
       audio_formats = EXCLUDED.audio_formats,
       last_fetched_at = now(),
       expires_at = EXCLUDED.expires_at`,
    [
      platform,
      mediaId,
      canonicalUrl,
      JSON.stringify(metadata),
      metadata.thumbnail ?? null,
      JSON.stringify(metadata.formats ?? []),
      JSON.stringify(metadata.audioFormats ?? []),
      expiresAt,
    ],
  );
}
