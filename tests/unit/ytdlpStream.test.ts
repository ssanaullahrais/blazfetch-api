import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

const children: FakeChild[] = [];
let nextPid = 1000;

// Never signal fake pids: route the tree-kill through the fake child's own kill().
vi.mock('../../src/core/processTree', () => ({
  processGroupOptions: {},
  killProcessTree: (child: { kill: (signal: string) => void }) => child.kill('SIGKILL'),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as FakeChild;
    child.pid = nextPid++;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      setImmediate(() => child.emit('close', null));
      return true;
    });
    children.push(child);
    return child;
  }),
}));

import { activeStreamProcessCount, spawnYtdlpToStdout } from '../../src/core/ytdlp/ytdlpStream';

beforeEach(() => {
  children.length = 0;
});

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    stream.on('data', (c) => (out += c.toString()));
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
}

describe('spawnYtdlpToStdout', () => {
  it('pipes the child stdout through and ends on exit code 0', async () => {
    const source = spawnYtdlpToStdout({ url: 'https://example.com/v', formatSelector: '18' });
    const done = collect(source.stream);
    children[0].stdout.write('abc');
    children[0].stdout.write('def');
    children[0].emit('close', 0);
    expect(await done).toBe('abcdef');
  });

  it('turns a failure before any data into a classified BlazfetchError', async () => {
    const source = spawnYtdlpToStdout({ url: 'https://example.com/v', formatSelector: '18' });
    const done = collect(source.stream);
    children[0].stderr.write('ERROR: This video is private video');
    await new Promise((r) => setImmediate(r));
    children[0].emit('close', 1);
    await expect(done).rejects.toMatchObject({ code: 'PRIVATE_MEDIA' });
  });

  it('kills the process and removes it from the active set when killed', async () => {
    const source = spawnYtdlpToStdout({ url: 'https://example.com/v', formatSelector: '18' });
    source.stream.on('error', () => undefined);
    expect(activeStreamProcessCount()).toBeGreaterThan(0);
    source.kill();
    source.kill(); // idempotent
    await new Promise((r) => setImmediate(r));
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(activeStreamProcessCount()).toBe(0);
  });

  it('kills the process when the abort signal fires', async () => {
    const abort = new AbortController();
    const source = spawnYtdlpToStdout({ url: 'https://example.com/v', formatSelector: '18', signal: abort.signal });
    const errored = new Promise((resolve) => source.stream.on('error', resolve));
    abort.abort();
    await errored;
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('never passes the URL through a shell and always writes to stdout without part files', async () => {
    const { spawn } = await import('node:child_process');
    spawnYtdlpToStdout({ url: 'https://example.com/v', formatSelector: '18' }).stream.on('error', () => undefined);
    const call = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(call[1]).toEqual(expect.arrayContaining(['-o', '-', '--no-part', '--no-playlist']));
    expect(call[2]).toMatchObject({ shell: false });
  });
});
