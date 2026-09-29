import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.API_AUTH_KEY',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.signedUrl',
      '*.cookies',
    ],
    censor: '[REDACTED]',
  },
  transport:
    env.APP_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
