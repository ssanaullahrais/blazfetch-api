import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { fetchRateLimiter } from '../../middleware/rateLimiter';
import { getMedia } from '../../controllers/mediaController';
import { requireTurnstile } from '../../middleware/turnstileGate';

const router = Router();

// Express 4 wildcard: everything after /media/ arrives as req.params[0].
router.get('/media/*', requireTurnstile, fetchRateLimiter, asyncHandler(getMedia));

export default router;
