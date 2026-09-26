import { getKnex } from './knexClient';
import { BeginDownloadLogInput, DownloadLogAttempt, DownloadLogLine, DownloadLogsStore } from '../types';

const MAX_ATTEMPTS_PER_MEDIA = 20;

export class SqlDownloadLogsRepository implements DownloadLogsStore {
  async begin(input: BeginDownloadLogInput): Promise<void> {
    const knex = getKnex();
    await knex('download_logs').insert({
      request_id: input.requestId,
      platform: input.platform,
      media_key: input.mediaKey,
      guest_id: input.guestId ?? null,
      user_id: input.userId ?? null,
      started_at: knex.fn.now(),
    });
  }

  async appendLine(requestId: string, level: DownloadLogLine['level'], message: string): Promise<void> {
    const knex = getKnex();
    // A no-op when requestId was never begun (see beginAttempt in downloadLogs.ts): nothing to attach to.
    const attempt = await knex('download_logs').where({ request_id: requestId }).first('request_id');
    if (!attempt) return;
    await knex('download_log_lines').insert({ request_id: requestId, ts: knex.fn.now(), level, message });
  }

  async listForMedia(platform: string, mediaKey: string, limit: number): Promise<DownloadLogAttempt[]> {
    const knex = getKnex();
    const attempts = await knex('download_logs')
      .where({ platform, media_key: mediaKey })
      .orderBy('id', 'desc')
      .limit(Math.min(limit, MAX_ATTEMPTS_PER_MEDIA))
      .select<{ request_id: string; started_at: string | Date }[]>('request_id', 'started_at');
    if (attempts.length === 0) return [];

    const requestIds = attempts.map((a) => a.request_id);
    const lines = await knex('download_log_lines')
      .whereIn('request_id', requestIds)
      .orderBy('ts', 'asc')
      .select<{ request_id: string; ts: string | Date; level: DownloadLogLine['level']; message: string }[]>(
        'request_id',
        'ts',
        'level',
        'message',
      );
    const linesByAttempt = new Map<string, DownloadLogLine[]>();
    for (const line of lines) {
      const list = linesByAttempt.get(line.request_id) ?? [];
      list.push({ ts: new Date(line.ts).toISOString(), level: line.level, message: line.message });
      linesByAttempt.set(line.request_id, list);
    }

    return attempts.map((a) => ({
      requestId: a.request_id,
      startedAt: new Date(a.started_at).toISOString(),
      lines: linesByAttempt.get(a.request_id) ?? [],
    }));
  }
}
