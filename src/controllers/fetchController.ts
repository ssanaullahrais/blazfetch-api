import { Request, Response } from 'express';
import { z } from 'zod';
import { fetchMedia } from '../services/fetchService';
import { fetchAudio } from '../services/audioService';
import { recordVisitorFetch } from '../services/statsService';

export const fetchBodySchema = z.object({
  url: z.string().min(1),
  forceRefresh: z.boolean().optional(),
  // 1-based, inclusive item range for collection URLs (Pinterest boards, etc), e.g.
  // { rangeStart: 50, rangeEnd: 100 } to fetch items 50 through 100. Ignored for non-collection URLs.
  rangeStart: z.number().int().positive().optional(),
  rangeEnd: z.number().int().positive().optional(),
});

export async function postFetch(req: Request, res: Response): Promise<void> {
  const { url, forceRefresh, rangeStart, rangeEnd } = req.body as z.infer<typeof fetchBodySchema>;
  const result = await fetchMedia({
    internal: true,
    url,
    forceRefresh,
    range: rangeStart || rangeEnd ? { start: rangeStart, end: rangeEnd } : undefined,
    requestId: req.requestId,
    userId: req.userId,
    guestId: req.guestId,
  });
  await recordVisitorFetch(result, { userId: req.userId, guestId: req.guestId });
  res.json(result);
}

export async function postFetchAudio(req: Request, res: Response): Promise<void> {
  const { url, forceRefresh } = req.body as z.infer<typeof fetchBodySchema>;
  // The visitor's fetch was already counted by POST /fetch: the audio lookup is not a second one.
  const result = await fetchAudio({
    internal: true,
    url,
    forceRefresh,
    requestId: req.requestId,
    userId: req.userId,
    guestId: req.guestId,
  });
  res.json(result);
}
