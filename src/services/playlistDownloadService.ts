import fs from 'node:fs';
import { env } from '../config/env';
import { BlazfetchError } from '../constants/errors';
import { JobRecord, RequestedFormat } from '../core/jobs/jobTypes';
import { createJob, getJob, getJobSignal, cancelJob, updateJobStatus, updateJobProgress, clearJobController } from '../core/jobs/jobManager';
import { cleanupJobTempDir } from '../core/jobs/tempFiles';
import { acquireVisitorDownloadSlots } from '../core/jobs/concurrencyLimiter';
import { normalizeAndResolveUrl } from '../utils/shortLinks';
import { validateAndNormalizeUrl } from '../utils/url';
import { fetchMedia } from './fetchService';
import { resolveFormat, runDownloadJob } from './downloadService';
import { logger } from '../lib/logger';

interface PlaylistParams {
  url: string; kind: 'video' | 'audio'; maxItems?: number;
  requestId: string; guestId?: string | null; userId?: string | null; networkKey?: string;
}

/** Child IDs live in the existing JSON job payload, persisted by every supported DB driver. */
export async function startPlaylistDownload(params: PlaylistParams): Promise<JobRecord> {
  const normalized = await normalizeAndResolveUrl(params.url);
  if (normalized.platform !== 'youtube' || !normalized.playlistId) throw new BlazfetchError('VALIDATION_ERROR', 'Provide a YouTube playlist URL.');
  const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(normalized.playlistId)}`;
  const workers = Math.min(env.PLAYLIST_DOWNLOAD_CONCURRENCY, params.userId ? env.MAX_CONCURRENT_DOWNLOADS_PER_USER : env.MAX_CONCURRENT_DOWNLOADS_PER_GUEST);
  const releases: (() => void)[] = [];
  const children: JobRecord[] = [];
  let parent: JobRecord | undefined;
  try {
    for (let i = 0; i < workers; i++) releases.push(acquireVisitorDownloadSlots({ ...params, kind: params.kind }));
    const media = await fetchMedia({ url: playlistUrl, requestId: params.requestId, internal: true, userId: params.userId, guestId: params.guestId });
    const items = media.playlist?.items.slice(0, Math.min(params.maxItems ?? env.MAX_PLAYLIST_DOWNLOAD_ITEMS, env.MAX_PLAYLIST_DOWNLOAD_ITEMS, env.MAX_PLAYLIST_ITEMS));
    if (!items?.length) throw new BlazfetchError('FORMAT_UNAVAILABLE', 'This playlist has no downloadable entries.');
    for (const item of items) {
      const source = validateAndNormalizeUrl(item.url);
      if (source.platform !== 'youtube' || !source.videoId) throw new BlazfetchError('INVALID_URL', 'The playlist contains an invalid item URL.');
      children.push(await createJob({ platform: 'youtube', mediaId: source.videoId, canonicalUrl: source.canonicalUrl, requestedFormat: { formatId: 'best', kind: params.kind }, userId: params.userId, guestId: params.guestId }));
    }
    parent = await createJob({ platform: 'youtube', mediaId: `playlist:${normalized.playlistId}`, canonicalUrl: playlistUrl, requestedFormat: { formatId: 'best', kind: params.kind, playlist: { title: media.title, items: items.map((item, index) => ({ id: children[index].id, title: item.title, url: children[index].canonicalUrl })) } }, userId: params.userId, guestId: params.guestId });
    const release = () => releases.splice(0).forEach((fn) => fn());
    void runPlaylist(parent, children, workers, params).catch((error) => {
      logger.error({ jobId: parent!.id, code: error instanceof BlazfetchError ? error.code : 'INTERNAL_ERROR' }, 'playlist runner failed');
    }).finally(release);
    return parent;
  } catch (error) {
    await Promise.all(children.map((job) => cancelJob(job.id).finally(() => clearJobController(job.id))));
    releases.splice(0).forEach((fn) => fn());
    throw error;
  }
}

async function runPlaylist(parent: JobRecord, children: JobRecord[], workers: number, params: PlaylistParams): Promise<void> {
  const signal = getJobSignal(parent.id);
  let next = 0;
  let processed = 0;
  let succeeded = 0;
  try {
    await updateJobStatus(parent.id, 'preparing');
    const worker = async () => {
      while (next < children.length && !signal.aborted) {
        const child = children[next++];
        try {
          const format: RequestedFormat = await resolveFormat(child.canonicalUrl, params.requestId, child.requestedFormat);
          if (signal.aborted) break;
          await runDownloadJob({ ...child, requestedFormat: format }, params.requestId, { visitorSlotHeld: true, persistDirect: true, networkKey: params.networkKey });
          succeeded++;
        } catch (error) {
          const current = await getJob(child.id);
          if (!['failed', 'cancelled'].includes(current.status)) await updateJobStatus(child.id, signal.aborted ? 'cancelled' : 'failed', { error_code: error instanceof BlazfetchError ? error.code : 'DOWNLOAD_FAILED', error_message: 'This playlist item could not be prepared.' });
        } finally {
          processed++;
          clearJobController(child.id);
          await updateJobProgress(parent.id, 0, undefined, Math.round(processed * 100 / children.length));
        }
      }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: workers }, worker));
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (!signal.aborted) await updateJobStatus(parent.id, succeeded ? 'ready' : 'failed', succeeded ? {} : { error_code: 'DOWNLOAD_FAILED', error_message: 'No playlist items could be prepared.' });
  } catch (error) {
    if (!signal.aborted) await updateJobStatus(parent.id, 'failed', { error_code: 'INTERNAL_ERROR', error_message: 'The playlist preparation was interrupted.' });
    await cancelPlaylistChildren(parent);
    throw error;
  } finally {
    clearJobController(parent.id);
  }
}

async function cancelPlaylistChildren(parent: JobRecord): Promise<void> {
  await Promise.all((parent.requestedFormat.playlist?.items ?? []).map(async ({ id }) => {
    const child = await getJob(id);
    if (['queued', 'preparing', 'streaming'].includes(child.status)) await cancelJob(id);
    await cleanupJobTempDir(id);
    clearJobController(id);
  }));
}

export async function cancelPlaylistDownload(parent: JobRecord): Promise<void> {
  await cancelJob(parent.id);
  await cancelPlaylistChildren(parent);
}

export async function playlistDownloadView(parent: JobRecord) {
  const playlist = parent.requestedFormat.playlist;
  if (!playlist) throw new BlazfetchError('JOB_NOT_FOUND', 'Playlist download was not found.');
  const items = await Promise.all(playlist.items.map(async (item) => {
    const child = await getJob(item.id);
    const available = child.status === 'ready' || (child.status === 'completed' && !!child.tempPath && fs.existsSync(child.tempPath));
    return { ...item, status: child.status, progress: child.progress, errorCode: child.errorCode, errorMessage: child.errorMessage, downloadUrl: available ? `/api/v1/downloads/${child.id}` : null };
  }));
  const prepared = items.filter((item) => item.downloadUrl).length;
  const failed = items.filter((item) => ['failed', 'cancelled', 'expired'].includes(item.status)).length;
  return { id: parent.id, status: parent.status, title: playlist.title, progress: parent.progress, total: items.length, prepared, failed, outcome: parent.status === 'ready' && failed ? 'partial' : parent.status, items };
}
