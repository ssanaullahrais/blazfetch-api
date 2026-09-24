import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import routes from './routes';

/**
 * Which browser origins may call the API with cookies. A wildcard would let any website use a visitor's cookies, so
 * in production it is treated as "no cross-origin access" (same-origin deployments do not need CORS at all).
 */
function corsOrigin(): boolean | string[] {
  const configured = env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  if (!configured.includes('*')) return configured;
  if (env.APP_ENV === 'production') {
    logger.warn('CORS_ALLOWED_ORIGINS is "*": cross-origin access is disabled in production. List your frontend origin instead.');
    return false;
  }
  return true;
}

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigin(),
      credentials: true,
      // Lets a browser fetch() read which delivery mode served the file and its suggested name.
      exposedHeaders: ['X-Blazfetch-Mode', 'Content-Disposition', 'X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
