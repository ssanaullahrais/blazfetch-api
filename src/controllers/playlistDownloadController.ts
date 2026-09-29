import { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { getJob } from '../core/jobs/jobManager';
import { assertOwnership } from '../core/jobs/ownership';
import { networkKey } from '../utils/clientKey';
import { startPlaylistDownload, cancelPlaylistDownload, playlistDownloadView } from '../services/playlistDownloadService';

export const playlistDownloadSchema = z.object({ url: z.string().min(1), kind: z.enum(['video', 'audio']).default('video'), maxItems: z.number().int().min(1).max(Math.min(env.MAX_PLAYLIST_ITEMS, env.MAX_PLAYLIST_DOWNLOAD_ITEMS)).optional() });

export async function postPlaylistDownload(req: Request, res: Response): Promise<void> {
  const parent = await startPlaylistDownload({ ...req.body, requestId: req.requestId, userId: req.userId, guestId: req.guestId, networkKey: networkKey(req) });
  res.status(202).json({ success: true, job: await playlistDownloadView(parent) });
}

export async function getPlaylistDownload(req: Request, res: Response): Promise<void> {
  const parent = await getJob(req.params.id);
  assertOwnership(req, parent);
  res.json({ success: true, job: await playlistDownloadView(parent) });
}

export async function deletePlaylistDownload(req: Request, res: Response): Promise<void> {
  const parent = await getJob(req.params.id);
  assertOwnership(req, parent);
  await playlistDownloadView(parent);
  await cancelPlaylistDownload(parent);
  res.json({ success: true, job: await playlistDownloadView(await getJob(parent.id)) });
}
