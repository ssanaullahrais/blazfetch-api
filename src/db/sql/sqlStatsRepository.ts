import { v4 as uuidv4 } from 'uuid';
import { getKnex } from './knexClient';
import { DownloadStatParams, FetchStatParams } from '../../services/statsService';
import { StatsStore } from '../types';

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
      created_at: knex.fn.now(),
    });
  }
}
