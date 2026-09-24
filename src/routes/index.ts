import { Router } from 'express';
import fetchRoutes from './v1/fetch.routes';
import downloadRoutes from './v1/download.routes';
import jobsRoutes from './v1/jobs.routes';
import platformsRoutes from './v1/platforms.routes';
import streamRoutes from './v1/stream.routes';
import { env } from '../config/env';
import healthRoutes from './health.routes';

const router = Router();

router.use('/api/v1', fetchRoutes);
router.use('/api/v1', downloadRoutes);
router.use('/api/v1', jobsRoutes);
router.use('/api/v1', platformsRoutes);
if (env.STREAM_MODE_ENABLED) router.use('/api/v1', streamRoutes);
router.use(healthRoutes);

export default router;
