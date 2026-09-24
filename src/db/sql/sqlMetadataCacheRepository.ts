import { v4 as uuidv4 } from 'uuid';
import { getKnex } from './knexClient';
import { env } from '../../config/env';
import { BlazfetchResponse } from '../../types/blazfetch';
import { MetadataCacheStore } from '../types';

interface MetadataCacheRow {
  id: string;
  platform: string;
  media_id: string;
  canonical_url: string;
  metadata: string | BlazfetchResponse;
  expires_at: Date | string;
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function isExpired(expiresAt: Date | string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}

export class SqlMetadataCacheRepository implements MetadataCacheStore {
  async get(platform: string, mediaId: string): Promise<BlazfetchResponse | null> {
    const row = await getKnex()<MetadataCacheRow>('metadata_cache').where({ platform, media_id: mediaId }).first();
    if (!row || isExpired(row.expires_at)) return null;
    return parseJson<BlazfetchResponse>(row.metadata);
  }

  async getByUrl(platform: string, canonicalUrl: string): Promise<BlazfetchResponse | null> {
    const row = await getKnex()<MetadataCacheRow>('metadata_cache')
      .where({ platform, canonical_url: canonicalUrl })
      .orderBy('last_fetched_at', 'desc')
      .first();
    if (!row || isExpired(row.expires_at)) return null;
    return parseJson<BlazfetchResponse>(row.metadata);
  }

  async set(platform: string, mediaId: string, canonicalUrl: string, metadata: BlazfetchResponse): Promise<void> {
    const knex = getKnex();
    const expiresAt = new Date(Date.now() + env.CACHE_TTL_SECONDS * 1000);
    const existing = await knex<MetadataCacheRow>('metadata_cache').where({ platform, media_id: mediaId }).first();

    const payload = {
      platform,
      media_id: mediaId,
      canonical_url: canonicalUrl,
      metadata: JSON.stringify(metadata),
      thumbnail: metadata.thumbnail ?? null,
      formats: JSON.stringify(metadata.formats ?? []),
      audio_formats: JSON.stringify(metadata.audioFormats ?? []),
      last_fetched_at: knex.fn.now(),
      expires_at: expiresAt,
    };

    if (existing) {
      await knex('metadata_cache').where({ id: existing.id }).update(payload);
    } else {
      await knex('metadata_cache').insert({ id: uuidv4(), ...payload });
    }
  }
}
