import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requireTurnstile } from '../../middleware/turnstileGate';
import { downloadRateLimiter } from '../../middleware/rateLimiter';
import { playlistDownloadSchema, postPlaylistDownload, getPlaylistDownload, deletePlaylistDownload } from '../../controllers/playlistDownloadController';

const router = Router();
router.post('/playlist/download', requireTurnstile, downloadRateLimiter, validateBody(playlistDownloadSchema), asyncHandler(postPlaylistDownload));
router.get('/playlist/downloads/:id', requireTurnstile, asyncHandler(getPlaylistDownload));
router.delete('/playlist/downloads/:id', asyncHandler(deletePlaylistDownload));
export default router;
