import { v4 as uuidv4 } from 'uuid';
import { getKnex } from './knexClient';
import { env } from '../../config/env';
import { DownloadStatParams, FetchStatParams } from '../../services/statsService';
import { StatsStore, StatsTotals } from '../types';

export class SqlStatsRepository implements StatsStore {
  async recordFetchStat(params: FetchStatParams): Promise<void> {
    const knex = getKnex();
    await knex('fetch_stats').insert({
      id: uuidv4(),
      platform: params.platform,
      media_id: params.mediaId ?? null,
      user_id: params.userId ?? null,
      guest_id: params.guestId ?? null,
      success: params.success,
      extractor: params.extractor ?? null,
      fallback_used: params.fallbackUsed ?? null,
      duration_ms: params.durationMs ?? null,
      error_code: params.errorCode ?? null,
      cache_hit: params.cacheHit ?? null,
      cache_stale: params.cacheStale ?? null,
      kind: params.kind ?? null,
      source: params.source ?? 'user',
      created_at: knex.fn.now(),
    });
  }

  async recordDownloadStat(params: DownloadStatParams): Promise<void> {
    const knex = getKnex();
    await knex('download_stats').insert({
      id: uuidv4(),
      job_id: params.jobId ?? null,
      platform: params.platform,
      media_id: params.mediaId ?? null,
      format: params.format ?? null,
      quality: params.quality ?? null,
      kind: params.kind,
      user_id: params.userId ?? null,
      guest_id: params.guestId ?? null,
      success: params.success,
      bytes_transferred: params.bytesTransferred ?? null,
      processing_duration_ms: params.processingDurationMs ?? null,
      error_code: params.errorCode ?? null,
      mode: params.mode ?? null,
      first_byte_ms: params.firstByteMs ?? null,
      fell_back: params.fellBack ?? null,
      created_at: knex.fn.now(),
    });
  }

  async totals(): Promise<StatsTotals> {
    const knex = getKnex();
    const windowStart = new Date(Date.now() - env.ONLINE_VISITOR_WINDOW_SECONDS * 1000);
    const [fetches] = await knex('fetch_stats').where({ success: true }).andWhere((q) => q.where({ source: 'user' }).orWhereNull('source')).count({ n: '*' });
    const [downloads] = await knex('download_stats').where({ success: true }).count({ n: '*' });
    const [online] = await knex('visitor_presence').where('last_seen_at', '>=', windowStart).count({ n: '*' });
    const perPlatform = await knex('download_stats').where({ success: true }).select('platform').count({ n: '*' }).groupBy('platform');
    const platforms: Record<string, number> = {};
    for (const row of perPlatform as unknown as { platform: string; n: number | string }[]) platforms[row.platform] = Number(row.n);
    return {
      fetches: Number((fetches as { n: number | string }).n),
      downloads: Number((downloads as { n: number | string }).n),
      platforms,
      online: Number((online as { n: number | string }).n),
    };
  }

  async recordPresence(visitorId: string): Promise<void> {
    const knex = getKnex();
    // insert-or-update in one round trip; a visitor with several open tabs collapses to the same row.
    await knex('visitor_presence')
      .insert({ visitor_id: visitorId, last_seen_at: knex.fn.now() })
      .onConflict('visitor_id')
      .merge({ last_seen_at: knex.fn.now() });
  }

  async prunePresence(olderThanMs: number): Promise<void> {
    const knex = getKnex();
    await knex('visitor_presence').where('last_seen_at', '<', new Date(Date.now() - olderThanMs)).delete();
  }
}
