import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { fetchRateLimiter } from '../../middleware/rateLimiter';
import { getMedia } from '../../controllers/mediaController';

const router = Router();

// Express 4 wildcard: everything after /media/ arrives as req.params[0].
router.get('/media/*', fetchRateLimiter, asyncHandler(getMedia));

export default router;
