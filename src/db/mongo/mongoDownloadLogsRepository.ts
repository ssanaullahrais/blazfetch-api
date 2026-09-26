import { getMongoDb } from './mongoClient';
import { BeginDownloadLogInput, DownloadLogAttempt, DownloadLogLine, DownloadLogsStore } from '../types';

const MAX_ATTEMPTS_PER_MEDIA = 20;

export class MongoDownloadLogsRepository implements DownloadLogsStore {
  async begin(input: BeginDownloadLogInput): Promise<void> {
    const db = await getMongoDb();
    await db.collection('download_logs').insertOne({
      _id: input.requestId,
      platform: input.platform,
      mediaKey: input.mediaKey,
      guestId: input.guestId ?? null,
      userId: input.userId ?? null,
      startedAt: new Date(),
    } as never);
  }

  async appendLine(requestId: string, level: DownloadLogLine['level'], message: string): Promise<void> {
    const db = await getMongoDb();
    // A no-op when requestId was never begun (see beginAttempt in downloadLogs.ts): nothing to attach to.
    const attempt = await db.collection('download_logs').findOne({ _id: requestId } as never, { projection: { _id: 1 } });
    if (!attempt) return;
    await db.collection('download_log_lines').insertOne({ requestId, ts: new Date(), level, message } as never);
  }

  async listForMedia(platform: string, mediaKey: string, limit: number): Promise<DownloadLogAttempt[]> {
    const db = await getMongoDb();
    const attempts = await db
      .collection('download_logs')
      .find({ platform, mediaKey } as never)
      .sort({ startedAt: -1 })
      .limit(Math.min(limit, MAX_ATTEMPTS_PER_MEDIA))
      .toArray();
    if (attempts.length === 0) return [];

    const requestIds = (attempts as unknown as { _id: string }[]).map((a) => a._id);
    const lines = await db
      .collection('download_log_lines')
      .find({ requestId: { $in: requestIds } } as never)
      .sort({ ts: 1 })
      .toArray();
    const linesByAttempt = new Map<string, DownloadLogLine[]>();
    for (const line of lines as unknown as { requestId: string; ts: Date; level: DownloadLogLine['level']; message: string }[]) {
      const list = linesByAttempt.get(line.requestId) ?? [];
      list.push({ ts: new Date(line.ts).toISOString(), level: line.level, message: line.message });
      linesByAttempt.set(line.requestId, list);
    }

    return (attempts as unknown as { _id: string; startedAt: Date }[]).map((a) => ({
      requestId: a._id,
      startedAt: new Date(a.startedAt).toISOString(),
      lines: linesByAttempt.get(a._id) ?? [],
    }));
  }
}
