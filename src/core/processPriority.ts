import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { env } from '../config/env';

/**
 * Runs a yt-dlp/ffmpeg/ffprobe process at a lower priority (MEDIA_PROCESS_NICE), so however many downloads and
 * conversions are running, the API itself keeps answering. Called right after spawn, before yt-dlp starts its own
 * ffmpeg (which inherits the priority).
 */
export function lowerPriority(child: ChildProcess): void {
  if (!env.MEDIA_PROCESS_NICE || child.pid === undefined) return;
  try {
    os.setPriority(child.pid, env.MEDIA_PROCESS_NICE);
  } catch {
    // Not permitted on this system, or the process already exited: it simply runs at normal priority.
  }
}
