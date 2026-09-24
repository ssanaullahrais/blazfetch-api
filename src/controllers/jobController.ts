import { Request, Response } from 'express';
import { getJob, cancelJob } from '../core/jobs/jobManager';
import { BlazfetchError } from '../constants/errors';

function assertOwnership(req: Request, job: Awaited<ReturnType<typeof getJob>>): void {
  const owner = job.userId ?? job.guestId;
  const requester = req.userId ?? req.guestId;
  if (owner && requester && owner !== requester) {
    throw new BlazfetchError('JOB_NOT_FOUND', `Job ${job.id} was not found.`);
  }
}

export async function getJobById(req: Request, res: Response): Promise<void> {
  const job = await getJob(req.params.id);
  assertOwnership(req, job);
  res.json({ success: true, job });
}

export async function deleteJobById(req: Request, res: Response): Promise<void> {
  const job = await getJob(req.params.id);
  assertOwnership(req, job);
  await cancelJob(job.id);
  res.json({ success: true, job: await getJob(job.id) });
}
