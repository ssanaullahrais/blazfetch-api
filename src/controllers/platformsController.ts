import { Request, Response } from 'express';
import { PLATFORMS } from '../constants/platforms';

export function getPlatforms(_req: Request, res: Response): void {
  res.json({ success: true, platforms: PLATFORMS });
}
