import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { requireTurnstile } from '../../middleware/turnstileGate';
import { downloadRateLimiter } from '../../middleware/rateLimiter';
import { getStream } from '../../controllers/streamController';

const router = Router();

router.get('/stream', requireTurnstile, downloadRateLimiter, asyncHandler(getStream));

export default router;
