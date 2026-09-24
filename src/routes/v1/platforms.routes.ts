import { Router } from 'express';
import { getPlatforms } from '../../controllers/platformsController';

const router = Router();

router.get('/platforms', getPlatforms);

export default router;
