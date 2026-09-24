import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { fetchRateLimiter } from '../../middleware/rateLimiter';
import { fetchBodySchema, postFetch, postFetchAudio } from '../../controllers/fetchController';

const router = Router();

router.post('/fetch', fetchRateLimiter, validateBody(fetchBodySchema), asyncHandler(postFetch));
router.post('/fetch/audio', fetchRateLimiter, validateBody(fetchBodySchema), asyncHandler(postFetchAudio));

export default router;
