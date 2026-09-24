import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { fetchRateLimiter } from '../../middleware/rateLimiter';
import { getConfig, postTurnstileVerify, verifyBodySchema } from '../../controllers/turnstileController';

const router = Router();

router.get('/config', getConfig);
router.post('/turnstile/verify', fetchRateLimiter, validateBody(verifyBodySchema), asyncHandler(postTurnstileVerify));

export default router;
