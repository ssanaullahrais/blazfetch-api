import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { deleteJobById, getJobById } from '../../controllers/jobController';

const router = Router();

router.get('/jobs/:id', asyncHandler(getJobById));
router.delete('/jobs/:id', asyncHandler(deleteJobById));

export default router;
