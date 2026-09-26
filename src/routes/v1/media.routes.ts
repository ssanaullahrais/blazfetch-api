import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { fetchRateLimiter } from '../../middleware/rateLimiter';
import { getMedia } from '../../controllers/mediaController';

const router = Router();

// Express 4 wildcard: everything after /media/ arrives as req.params[0].
// No Turnstile gate here: this just serves an already-stored result (no yt-dlp work), and it's the endpoint a
// stable/shared link opens — a brand-new visitor arriving from one should see the page immediately, not a CAPTCHA
// before they've done anything. Still rate-limited like every other read.
router.get('/media/*', fetchRateLimiter, asyncHandler(getMedia));

export default router;
