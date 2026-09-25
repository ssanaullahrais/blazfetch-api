import type { BlazfetchResponse } from '../types/blazfetch';

function sanitizeFilename(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

/** The name a download is saved under: the one the page asked for, else the title, else the media id. */
export function buildFilename(requested: string | undefined, media: Pick<BlazfetchResponse, 'title' | 'mediaId'>, ext: string): string {
  const base = sanitizeFilename(requested ?? '') || sanitizeFilename(media.title ?? '') || sanitizeFilename(media.mediaId) || 'download';
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}
