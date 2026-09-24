import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requireTurnstile } from '../../middleware/turnstileGate';
import { fetchRateLimiter } from '../../middleware/rateLimiter';
import { fetchBodySchema, postFetch, postFetchAudio } from '../../controllers/fetchController';

const router = Router();

router.post('/fetch', requireTurnstile, fetchRateLimiter, validateBody(fetchBodySchema), asyncHandler(postFetch));
router.post('/fetch/audio', requireTurnstile, fetchRateLimiter, validateBody(fetchBodySchema), asyncHandler(postFetchAudio));

export default router;
