import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { validateBody } from '../../middleware/validate';
import { requireTurnstile } from '../../middleware/turnstileGate';
import { downloadRateLimiter } from '../../middleware/rateLimiter';
import { downloadBodySchema, deleteDownload, getDownloadStream, postDownload } from '../../controllers/downloadController';

const router = Router();

router.post('/download', requireTurnstile, downloadRateLimiter, validateBody(downloadBodySchema), asyncHandler(postDownload));
router.get('/downloads/:id', asyncHandler(getDownloadStream));
router.delete('/downloads/:id', asyncHandler(deleteDownload));

export default router;
