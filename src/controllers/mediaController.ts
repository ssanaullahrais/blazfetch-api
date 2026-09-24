import { Request, Response } from 'express';
import { z } from 'zod';
import { BlazfetchError } from '../constants/errors';
import { getDb } from '../db';
import { parseMediaPath, sourceUrlForKey } from '../core/media/mediaPath';
import { fetchMedia, isPublicSource } from '../services/fetchService';

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

  const response = await fetchMedia({ url: sourceUrl, requestId: req.requestId, userId: req.userId, guestId: req.guestId });
  void store.recordAccess(parsed.platform, parsed.mediaKey, 'view').catch(() => undefined);
  res.json(response);
}
