import { getMongoDb } from './mongoClient';
import { kindOfKey } from '../../core/media/mediaPath';
import { BlazfetchResponse } from '../../types/blazfetch';
import { CheckFailureInput, MediaStatus, MetadataCacheStore, StoredMedia, UpsertMediaInput } from '../types';

interface MediaDoc {
  platform: string;
  mediaId: string;
  kind: 'video' | 'playlist';
  canonicalUrl: string;
  sourceUrl?: string;
  path?: string | null;
  metadata: BlazfetchResponse;
  title?: string | null;
  authorName?: string | null;
  durationSeconds?: number | null;
  extractor?: string | null;
  status?: MediaStatus;
  unavailableReason?: string | null;
  unavailableSince?: Date | null;
  isPublic?: boolean;
  checkFailCount?: number;
  firstFetchedAt?: Date;
  lastFetchedAt: Date;
  expiresAt: Date;
  validatedAt?: Date | null;
  lastCheckAt?: Date | null;
  nextCheckAt?: Date | null;
  lastAccessedAt?: Date | null;
  lastDownloadedAt?: Date | null;
  fetchCount?: number;
  hitCount?: number;
  viewCount?: number;
  downloadCount?: number;
  streamCount?: number;
  prepareCount?: number;
  bytesServed?: number;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function docToMedia(doc: MediaDoc): StoredMedia {
  return {
    platform: doc.platform,
    mediaKey: doc.mediaId,
    kind: doc.kind === 'playlist' ? 'playlist' : 'video',
    canonicalUrl: doc.canonicalUrl,
    sourceUrl: doc.sourceUrl ?? doc.canonicalUrl,
    path: doc.path ?? null,
    metadata: doc.metadata,
    status: doc.status === 'unavailable' ? 'unavailable' : 'available',
    unavailableReason: doc.unavailableReason ?? null,
    unavailableSince: iso(doc.unavailableSince),
    isPublic: doc.isPublic !== false,
    checkFailCount: doc.checkFailCount ?? 0,
    firstFetchedAt: (doc.firstFetchedAt ?? doc.lastFetchedAt).toISOString(),
    lastFetchedAt: doc.lastFetchedAt.toISOString(),
    urlsExpireAt: doc.expiresAt.toISOString(),
    validatedAt: iso(doc.validatedAt),
    lastCheckAt: iso(doc.lastCheckAt),
    nextCheckAt: iso(doc.nextCheckAt),
    lastAccessedAt: iso(doc.lastAccessedAt),
    lastDownloadedAt: iso(doc.lastDownloadedAt),
    counters: {
      fetchCount: doc.fetchCount ?? 0,
      hitCount: doc.hitCount ?? 0,
      viewCount: doc.viewCount ?? 0,
      downloadCount: doc.downloadCount ?? 0,
      streamCount: doc.streamCount ?? 0,
      prepareCount: doc.prepareCount ?? 0,
      bytesServed: doc.bytesServed ?? 0,
    },
  };
}

async function media() {
  return (await getMongoDb()).collection<MediaDoc>('metadata_cache');
}

export class MongoMetadataCacheRepository implements MetadataCacheStore {
  async findByKey(platform: string, mediaKey: string): Promise<StoredMedia | null> {
    const doc = await (await media()).findOne({ platform, mediaId: mediaKey });
    return doc ? docToMedia(doc) : null;
  }

  async findByUrl(platform: string, canonicalUrl: string): Promise<StoredMedia | null> {
    const doc = await (await media()).findOne({ platform, canonicalUrl }, { sort: { lastFetchedAt: -1 } });
    return doc ? docToMedia(doc) : null;
  }

  async upsert(input: UpsertMediaInput): Promise<void> {
    const now = new Date();
    await (await media()).updateOne(
      { platform: input.platform, mediaId: input.mediaKey },
      {
        $set: {
          platform: input.platform,
          mediaId: input.mediaKey,
          kind: kindOfKey(input.mediaKey),
          canonicalUrl: input.canonicalUrl,
          sourceUrl: input.sourceUrl,
          path: input.path,
          metadata: input.metadata,
          title: input.metadata.title ?? input.metadata.playlist?.title ?? null,
          authorName: input.metadata.author?.name ?? input.metadata.playlist?.channel ?? null,
          durationSeconds: typeof input.metadata.durationSeconds === 'number' ? Math.round(input.metadata.durationSeconds) : null,
          extractor: input.metadata.extractor ?? null,
          isPublic: input.isPublic,
          lastFetchedAt: now,
          expiresAt: input.urlsExpireAt,
          status: 'available',
          unavailableReason: null,
          unavailableSince: null,
          checkFailCount: 0,
          validatedAt: now,
          lastCheckAt: now,
          nextCheckAt: input.nextCheckAt,
        },
        $setOnInsert: {
          firstFetchedAt: now,
          hitCount: 0,
          viewCount: 0,
          downloadCount: 0,
          streamCount: 0,
          prepareCount: 0,
          bytesServed: 0,
        },
        $inc: { fetchCount: 1 },
      },
      { upsert: true },
    );
  }

  async recordCheckFailure(platform: string, mediaKey: string, input: CheckFailureInput): Promise<{ status: MediaStatus; checkFailCount: number }> {
    const col = await media();
    const doc = await col.findOne({ platform, mediaId: mediaKey });
    if (!doc) return { status: 'available', checkFailCount: 0 };

    const now = new Date();
    const failures = input.permanent ? (doc.checkFailCount ?? 0) + 1 : doc.checkFailCount ?? 0;
    const unavailable = doc.status === 'unavailable' || (input.permanent && failures >= input.threshold);

    const set: Partial<MediaDoc> = {
      checkFailCount: failures,
      lastCheckAt: now,
      nextCheckAt: input.nextCheckAt,
      status: unavailable ? 'unavailable' : 'available',
    };
    if (unavailable && input.permanent) set.unavailableReason = input.code;
    if (unavailable && !doc.unavailableSince) set.unavailableSince = now;
    await col.updateOne({ platform, mediaId: mediaKey }, { $set: set });

    return { status: unavailable ? 'unavailable' : 'available', checkFailCount: failures };
  }

  async scheduleNextCheck(platform: string, mediaKey: string, nextCheckAt: Date): Promise<void> {
    await (await media()).updateOne({ platform, mediaId: mediaKey }, { $set: { nextCheckAt } });
  }

  async recordAccess(platform: string, mediaKey: string, type: 'hit' | 'view'): Promise<void> {
    await (await media()).updateOne(
      { platform, mediaId: mediaKey },
      { $inc: { [type === 'hit' ? 'hitCount' : 'viewCount']: 1 }, $set: { lastAccessedAt: new Date() } },
    );
  }

  async recordDownload(platform: string, mediaKey: string, params: { mode: 'stream' | 'prepare'; bytes: number }): Promise<void> {
    const now = new Date();
    await (await media()).updateOne(
      { platform, mediaId: mediaKey },
      {
        $inc: {
          downloadCount: 1,
          [params.mode === 'stream' ? 'streamCount' : 'prepareCount']: 1,
          bytesServed: Math.max(0, Math.round(params.bytes)),
        },
        $set: { lastDownloadedAt: now, lastAccessedAt: now },
      },
    );
  }

  async listDue(now: Date, limit: number): Promise<StoredMedia[]> {
    const docs = await (await media())
      .find({ $or: [{ nextCheckAt: null }, { nextCheckAt: { $exists: false } }, { nextCheckAt: { $lte: now } }] })
      .sort({ nextCheckAt: 1 })
      .limit(limit)
      .toArray();
    return docs.map(docToMedia);
  }
}
