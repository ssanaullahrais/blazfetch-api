import { v4 as uuidv4 } from 'uuid';
import { Knex } from 'knex';
import { getKnex } from './knexClient';
import { toIso, toIsoOrNull } from './time';
import { kindOfKey } from '../../core/media/mediaPath';
import { BlazfetchResponse } from '../../types/blazfetch';
import { CheckFailureInput, MediaStatus, MetadataCacheStore, StoredMedia, UpsertMediaInput } from '../types';

interface MediaRow {
  id: string;
  platform: string;
  media_id: string;
  kind: string;
  canonical_url: string;
  source_url: string | null;
  path: string | null;
  metadata: string | BlazfetchResponse;
  status: string;
  unavailable_reason: string | null;
  unavailable_since: Date | string | number | null;
  is_public: boolean | number;
  check_fail_count: number | string;
  first_fetched_at: Date | string | number | null;
  last_fetched_at: Date | string | number;
  expires_at: Date | string | number;
  validated_at: Date | string | number | null;
  last_check_at: Date | string | number | null;
  next_check_at: Date | string | number | null;
  last_accessed_at: Date | string | number | null;
  last_downloaded_at: Date | string | number | null;
  fetch_count: number | string;
  hit_count: number | string;
  view_count: number | string;
  download_count: number | string;
  stream_count: number | string;
  prepare_count: number | string;
  bytes_served: number | string;
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function rowToMedia(row: MediaRow): StoredMedia {
  const lastFetchedAt = toIso(row.last_fetched_at);
  return {
    platform: row.platform,
    mediaKey: row.media_id,
    kind: row.kind === 'playlist' ? 'playlist' : 'video',
    canonicalUrl: row.canonical_url,
    sourceUrl: row.source_url ?? row.canonical_url,
    path: row.path,
    metadata: parseJson<BlazfetchResponse>(row.metadata),
    status: row.status === 'unavailable' ? 'unavailable' : 'available',
    unavailableReason: row.unavailable_reason,
    unavailableSince: toIsoOrNull(row.unavailable_since),
    isPublic: row.is_public === true || row.is_public === 1,
    checkFailCount: Number(row.check_fail_count),
    firstFetchedAt: toIsoOrNull(row.first_fetched_at) ?? lastFetchedAt,
    lastFetchedAt,
    urlsExpireAt: toIso(row.expires_at),
    validatedAt: toIsoOrNull(row.validated_at),
    lastCheckAt: toIsoOrNull(row.last_check_at),
    nextCheckAt: toIsoOrNull(row.next_check_at),
    lastAccessedAt: toIsoOrNull(row.last_accessed_at),
    lastDownloadedAt: toIsoOrNull(row.last_downloaded_at),
    counters: {
      fetchCount: Number(row.fetch_count),
      hitCount: Number(row.hit_count),
      viewCount: Number(row.view_count),
      downloadCount: Number(row.download_count),
      streamCount: Number(row.stream_count),
      prepareCount: Number(row.prepare_count),
      bytesServed: Number(row.bytes_served),
    },
  };
}

/** The searchable/displayable facts pulled out of the stored response into their own columns. */
function columnsFromMetadata(metadata: BlazfetchResponse): Record<string, unknown> {
  return {
    title: metadata.title ?? metadata.playlist?.title ?? null,
    author_name: metadata.author?.name ?? metadata.playlist?.channel ?? null,
    duration_seconds: typeof metadata.durationSeconds === 'number' ? Math.round(metadata.durationSeconds) : null,
    extractor: metadata.extractor ?? null,
    thumbnail: metadata.thumbnail ?? metadata.playlist?.thumbnail ?? null,
    formats: JSON.stringify(metadata.formats ?? []),
    audio_formats: JSON.stringify(metadata.audioFormats ?? []),
  };
}

export class SqlMetadataCacheRepository implements MetadataCacheStore {
  private table(): Knex.QueryBuilder<MediaRow> {
    return getKnex()<MediaRow>('metadata_cache');
  }

  async findByKey(platform: string, mediaKey: string): Promise<StoredMedia | null> {
    const row = await this.table().where({ platform, media_id: mediaKey }).first();
    return row ? rowToMedia(row) : null;
  }

  async findByUrl(platform: string, canonicalUrl: string): Promise<StoredMedia | null> {
    const row = await this.table().where({ platform, canonical_url: canonicalUrl }).orderBy('last_fetched_at', 'desc').first();
    return row ? rowToMedia(row) : null;
  }

  async upsert(input: UpsertMediaInput): Promise<void> {
    const knex = getKnex();
    const now = new Date();
    const shared = {
      canonical_url: input.canonicalUrl,
      source_url: input.sourceUrl,
      path: input.path,
      kind: kindOfKey(input.mediaKey),
      metadata: JSON.stringify(input.metadata),
      is_public: input.isPublic,
      last_fetched_at: now,
      expires_at: input.urlsExpireAt,
      status: 'available',
      unavailable_reason: null,
      unavailable_since: null,
      check_fail_count: 0,
      validated_at: now,
      last_check_at: now,
      next_check_at: input.nextCheckAt,
      ...columnsFromMetadata(input.metadata),
    };

    const update = async (): Promise<number> =>
      this.table()
        .where({ platform: input.platform, media_id: input.mediaKey })
        .update({ ...shared, fetch_count: knex.raw('fetch_count + 1') } as never);

    if ((await update()) > 0) return;

    try {
      await this.table().insert({
        id: uuidv4(),
        platform: input.platform,
        media_id: input.mediaKey,
        ...shared,
        first_fetched_at: now,
        fetch_count: 1,
      } as never);
    } catch (err) {
      // Two requests fetched the same new media at once and the other one inserted first.
      if ((await update()) === 0) throw err;
    }
  }

  async recordCheckFailure(platform: string, mediaKey: string, input: CheckFailureInput): Promise<{ status: MediaStatus; checkFailCount: number }> {
    const row = await this.table().where({ platform, media_id: mediaKey }).first();
    if (!row) return { status: 'available', checkFailCount: 0 };

    const now = new Date();
    const failures = input.permanent ? Number(row.check_fail_count) + 1 : Number(row.check_fail_count);
    const unavailable = row.status === 'unavailable' || (input.permanent && failures >= input.threshold);

    await this.table()
      .where({ platform, media_id: mediaKey })
      .update({
        check_fail_count: failures,
        last_check_at: now,
        next_check_at: input.nextCheckAt,
        status: unavailable ? 'unavailable' : 'available',
        ...(unavailable && input.permanent ? { unavailable_reason: input.code } : {}),
        ...(unavailable && !row.unavailable_since ? { unavailable_since: now } : {}),
      } as never);

    return { status: unavailable ? 'unavailable' : 'available', checkFailCount: failures };
  }

  async scheduleNextCheck(platform: string, mediaKey: string, nextCheckAt: Date): Promise<void> {
    await this.table().where({ platform, media_id: mediaKey }).update({ next_check_at: nextCheckAt } as never);
  }

  async recordAccess(platform: string, mediaKey: string, type: 'hit' | 'view'): Promise<void> {
    const knex = getKnex();
    const column = type === 'hit' ? 'hit_count' : 'view_count';
    await this.table()
      .where({ platform, media_id: mediaKey })
      .update({ [column]: knex.raw(`${column} + 1`), last_accessed_at: new Date() } as never);
  }

  async recordDownload(platform: string, mediaKey: string, params: { mode: 'stream' | 'prepare'; bytes: number }): Promise<void> {
    const knex = getKnex();
    const modeColumn = params.mode === 'stream' ? 'stream_count' : 'prepare_count';
    const now = new Date();
    await this.table()
      .where({ platform, media_id: mediaKey })
      .update({
        download_count: knex.raw('download_count + 1'),
        [modeColumn]: knex.raw(`${modeColumn} + 1`),
        bytes_served: knex.raw('bytes_served + ?', [Math.max(0, Math.round(params.bytes))]),
        last_downloaded_at: now,
        last_accessed_at: now,
      } as never);
  }

  async listDue(now: Date, limit: number): Promise<StoredMedia[]> {
    const rows = await this.table()
      .where((q) => q.whereNull('next_check_at').orWhere('next_check_at', '<=', now))
      .orderBy('next_check_at', 'asc')
      .limit(limit);
    return rows.map(rowToMedia);
  }
}
