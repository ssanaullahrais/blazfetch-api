import { ChildProcess, spawn } from 'node:child_process';

/**
 * yt-dlp launches ffmpeg (and sometimes other helpers) as its own children, and SIGKILL on the parent
 * alone leaves those running. Spawn with these options, and stop with killProcessTree(), so a cancelled
 * or timed-out download never leaves an orphan behind.
 *
 * On POSIX the child leads its own process group, which killProcessTree() signals as a whole. On
 * Windows there are no groups, so `taskkill /T` walks the process tree instead.
 */
export const processGroupOptions: { detached: boolean } = { detached: process.platform !== 'win32' };

export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }

  if (process.platform === 'win32') {
    // taskkill must walk the tree BEFORE the parent dies (children are found through their parent pid),
    // so the direct kill is only a fallback if taskkill itself couldn't run or failed.
    const fallback = (): void => void child.kill('SIGKILL');
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', fallback);
    killer.on('close', (code) => {
      if (code !== 0) fallback();
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone or not signalable; the direct kill below still runs.
  }
  child.kill('SIGKILL');
}
