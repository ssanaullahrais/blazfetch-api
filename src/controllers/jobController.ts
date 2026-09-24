import { Request, Response } from 'express';
import { getJob, cancelJob } from '../core/jobs/jobManager';
import { assertOwnership } from '../core/jobs/ownership';

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
