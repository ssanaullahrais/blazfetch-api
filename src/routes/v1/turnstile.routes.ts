import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { fetchRateLimiter } from '../../middleware/rateLimiter';
import { getStats, streamStats } from '../../controllers/statsController';
import { getConfig, postTurnstileVerify, verifyBodySchema } from '../../controllers/turnstileController';

const router = Router();

router.get('/config', getConfig);
router.get('/stats', asyncHandler(getStats));
router.get('/stats/events', streamStats);
router.post('/turnstile/verify', fetchRateLimiter, validateBody(verifyBodySchema), asyncHandler(postTurnstileVerify));

export default router;
