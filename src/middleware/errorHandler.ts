import { NextFunction, Request, Response } from 'express';
import { BlazfetchError, ErrorCode } from '../constants/errors';
import { logger } from '../lib/logger';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: { code: ErrorCode.NOT_FOUND, message: `Route ${req.method} ${req.path} not found.` },
    requestId: req.requestId,
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof BlazfetchError) {
    logger.warn({ requestId: req.requestId, code: err.code, err: err.message }, 'handled error');
    res.status(err.status).json({
      success: false,
      // A tombstone explains what the media was, so a page can still show that it existed.
      error: { code: err.code, message: err.message, ...(err.code === 'MEDIA_UNAVAILABLE' ? { details: err.details } : {}) },
      requestId: req.requestId,
    });
    return;
  }

  logger.error({ requestId: req.requestId, err }, 'unhandled error');
  res.status(500).json({
    success: false,
    error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred.' },
    requestId: req.requestId,
  });
}
