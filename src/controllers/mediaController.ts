import { Request, Response } from 'express';
import { z } from 'zod';
import { BlazfetchError } from '../constants/errors';
import { getDb } from '../db';
import { parseMediaPath, sourceUrlForKey } from '../core/media/mediaPath';
import { fetchMedia, isPublicSource } from '../services/fetchService';
import { presentMedia } from '../utils/audioMp3';
import { recordVisitorFetch } from '../services/statsService';
import { getVisitorLogs } from '../services/downloadLogs';

const querySchema = z.object({
  // Only answer from what is already stored; never extract from the source.
  cacheOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/**
 * GET /api/v1/media/<platform>/<id>
 * GET /api/v1/media/<platform>/<id>/playlist/<listId>   (also /<platform>/playlist/<listId>)
 *
 * Serves stored media by its stable path. Stored items are answered from the database; one that has
 * never been fetched is fetched now (when its link can be rebuilt from the id) unless ?cacheOnly=true.
 * A stored item that is due for its weekly existence check is re-checked first, and one found gone
 * answers 410 MEDIA_UNAVAILABLE with a tombstone (title, thumbnail, when it disappeared).
 */
export async function getMedia(req: Request, res: Response): Promise<void> {
  const { cacheOnly } = querySchema.parse(req.query);
  const parsed = parseMediaPath(`/${String(req.params[0] ?? '')}`);
  if (!parsed) {
    throw new BlazfetchError('MEDIA_NOT_FOUND', 'Unknown media path. Use /api/v1/media/<platform>/<id>.');
  }

  const store = getDb().metadataCache;
  const stored = await store.findByKey(parsed.platform, parsed.mediaKey);

  // Anything only reachable with the operator's own login is never served by path.
  if (stored ? !stored.isPublic : !isPublicSource(parsed.platform)) {
    throw new BlazfetchError('MEDIA_NOT_FOUND', 'This media is not available.');
  }

  let sourceUrl: string | undefined;
  if (stored) {
    sourceUrl = stored.canonicalUrl;
  } else {
    if (cacheOnly) throw new BlazfetchError('MEDIA_NOT_FOUND', 'This media has not been fetched yet.');
    sourceUrl = sourceUrlForKey(parsed.platform, parsed.mediaKey);
    if (!sourceUrl) {
      throw new BlazfetchError(
        'MEDIA_NOT_FOUND',
        'This media has not been fetched yet, and its link cannot be rebuilt from the id alone. Call POST /api/v1/fetch with the original URL first.',
      );
    }
  }

  const response = await fetchMedia({ url: sourceUrl, requestId: req.requestId, userId: req.userId, guestId: req.guestId, internal: true });
  await recordVisitorFetch(response, { userId: req.userId, guestId: req.guestId });
  void store.recordAccess(parsed.platform, parsed.mediaKey, 'view').catch(() => undefined);
  res.json(presentMedia(response));
}

/**
 * GET /api/v1/media/<platform>/<id>/logs
 *
 * Lets a visitor look back at what happened on their own recent GET /stream attempts for this media — useful
 * when a download seemed to hang or fail and they want the real reason, not just a generic error toast. Only
 * ever shows attempts started by the same guest/user cookie that is asking; in-memory and short-lived (see
 * downloadLogs.ts), and currently only tracked for YouTube, the one platform whose id is predictable from the
 * URL before anything is fetched.
 */
export async function getMediaLogs(req: Request, res: Response): Promise<void> {
  const { platform, id } = req.params;
  const attempts = getVisitorLogs(platform, id, req.guestId, req.userId);
  if (!attempts) {
    throw new BlazfetchError('MEDIA_NOT_FOUND', 'No recent download attempt from you was found for this media.');
  }
  res.json({
    success: true,
    platform,
    mediaId: id,
    attempts: attempts.map((a) => ({
      requestId: a.requestId,
      startedAt: a.startedAt,
      lines: a.lines,
    })),
  });
}
