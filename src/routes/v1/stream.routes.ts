import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { downloadRateLimiter } from '../../middleware/rateLimiter';
import { getStream } from '../../controllers/streamController';

const router = Router();

router.get('/stream', downloadRateLimiter, asyncHandler(getStream));

export default router;
