import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { getHealth, getReadiness } from '../controllers/healthController';

const router = Router();

router.get('/health', getHealth);
router.get('/health/ready', asyncHandler(getReadiness));

export default router;
