import { Request } from 'express';
import { BlazfetchError } from '../../constants/errors';
import type { getJob } from './jobManager';

/** A job may only be read, cancelled or downloaded by the visitor who started it. */
export function assertOwnership(req: Request, job: Awaited<ReturnType<typeof getJob>>): void {
  const owner = job.userId ?? job.guestId;
  const requester = req.userId ?? req.guestId;
  if (owner && requester && owner !== requester) {
    throw new BlazfetchError('JOB_NOT_FOUND', `Job ${job.id} was not found.`);
  }
}
