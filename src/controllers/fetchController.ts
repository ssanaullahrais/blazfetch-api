import { Request, Response } from 'express';
import { z } from 'zod';
import { fetchMedia } from '../services/fetchService';
import { fetchAudio } from '../services/audioService';

export const fetchBodySchema = z.object({
  url: z.string().min(1),
  forceRefresh: z.boolean().optional(),
});

export async function postFetch(req: Request, res: Response): Promise<void> {
  const { url, forceRefresh } = req.body as z.infer<typeof fetchBodySchema>;
  const result = await fetchMedia({
    url,
    forceRefresh,
    requestId: req.requestId,
    userId: req.userId,
    guestId: req.guestId,
  });
  res.json(result);
}

export async function postFetchAudio(req: Request, res: Response): Promise<void> {
  const { url, forceRefresh } = req.body as z.infer<typeof fetchBodySchema>;
  const result = await fetchAudio({
    url,
    forceRefresh,
    requestId: req.requestId,
    userId: req.userId,
    guestId: req.guestId,
  });
  res.json(result);
}
