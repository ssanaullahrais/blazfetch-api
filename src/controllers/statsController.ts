import { Request, Response } from 'express';
import { getStatsTotals } from '../services/statsTotalsService';

/** Public, anonymous totals (no per-visitor data). */
export async function getStats(_req: Request, res: Response): Promise<void> {
  const totals = await getStatsTotals();
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ success: true, ...totals });
}
