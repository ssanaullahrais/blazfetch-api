import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { BlazfetchError } from '../constants/errors';

export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new BlazfetchError('VALIDATION_ERROR', 'Invalid request body.', result.error.flatten()));
      return;
    }
    req.body = result.data;
    next();
  };
}
