import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// A real HTTP/extractor/download check, isolated from the deployment database and credentials.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blazfetch-platform-smoke-'));
process.env.VITEST = '1';
process.env.APP_ENV = 'test';
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_SQLITE_PATH = path.join(directory, 'audit.sqlite3');
process.env.TEMP_DIR = path.join(directory, 'downloads');
process.env.LOG_LEVEL = 'silent';
process.env.MAX_PLAYLIST_ITEMS = process.argv.find((arg) => arg.startsWith('--playlist-limit='))?.slice(17) ?? (process.argv.includes('--serve') ? '1000' : '3');
process.env.RATE_LIMIT_MAX_GUEST = '1000';
process.env.RATE_LIMIT_MAX_DOWNLOAD = '1000';

const requested = process.argv.find((arg) => arg.startsWith('--platform='))?.slice(11).split(',');
const download = process.argv.includes('--download');
const best = process.argv.includes('--best');
const audioOnly = process.argv.includes('--audio');
const bulk = process.argv.includes('--bulk');
const prepare = process.argv.includes('--prepare');
const apiHeaders = process.env.API_AUTH_ENABLED === 'true' && process.env.API_AUTH_KEY ? { 'X-API-Key': process.env.API_AUTH_KEY } : {};
const ownerHeaders = { ...apiHeaders, cookie: 'blazfetch_guest_id=22222222-2222-4222-8222-222222222222' };
const results: Record<string, unknown>[] = [];

async function main(): Promise<void> {
  const { createApp } = await import('../src/app');
  const { getDb } = await import('../src/db');
  const { env } = await import('../src/config/env');
  const { PLATFORMS } = await import('../src/constants/platforms');
  await getDb().migrate();
  const serve = process.argv.includes('--serve');
  const server = createApp().listen(serve ? 4000 : 0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  console.log(`Artifacts: ${directory}`);
  if (serve) {
    console.log(`Isolated browser audit API: ${base}`);
    return;
  }
  try {
    const cases = PLATFORMS.map(({ id }) => ({ name: id as string, url: fixtureUrl(id) }));
    cases.push({ name: 'youtube-playlist', url: fixtureUrl('youtube-playlist') });
    for (const sample of cases.filter(({ name }) => !requested || requested.includes(name))) {
      const started = Date.now();
      const result: Record<string, unknown> = { platform: sample.name, source: sample.url };
      try {
        const metadataResponse = await fetch(`${base}/api/v1/fetch`, {
          method: 'POST', headers: { ...apiHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ url: sample.url }), signal: AbortSignal.timeout(100_000),
        });
        const media = await metadataResponse.json() as {
          success: boolean; error?: unknown; mediaType: string; extractor: string;
          formats: { formatId: string; kind: string; height?: number; compatible?: boolean }[];
          audioFormats: { formatId: string }[];
          playlist?: { items: { url: string }[] };
        };
        result.fetchStatus = metadataResponse.status;
        if (!metadataResponse.ok || !media.success) throw new Error(JSON.stringify(media.error));
        result.extractor = media.extractor;
        result.kind = media.mediaType;
        result.formats = media.formats.length;
        result.audioFormats = media.audioFormats.length;
        result.playlistItems = media.playlist?.items.length;
        if (download) {
          let sources: { url: string; format: string; kind: string; downloadUrl?: string }[] = media.playlist ? media.playlist.items.map((item) => ({ url: item.url, format: 'best', kind: audioOnly ? 'audio' : 'video' })) : [{
            url: sample.url,
            format: best ? 'best' : audioOnly ? media.audioFormats[0]?.formatId ?? 'best' : [...media.formats].filter((f) => f.kind === 'video' && f.compatible !== false).sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0]?.formatId ?? media.formats[0]?.formatId ?? media.audioFormats[0]?.formatId ?? 'best',
            kind: !audioOnly && media.formats.length ? 'video' : 'audio',
          }];
          if (bulk && media.playlist) {
            const created = await fetch(`${base}/api/v1/playlist/download`, { method: 'POST', headers: { ...ownerHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ url: sample.url, kind: audioOnly ? 'audio' : 'video', maxItems: 1 }) });
            const data = await created.json() as { job?: { id: string } };
            if (!created.ok || !data.job) throw new Error(`Bulk creation failed: ${JSON.stringify(data)}`);
            const deadline = Date.now() + 600_000;
            while (true) {
              const status = await fetch(`${base}/api/v1/playlist/downloads/${data.job.id}`, { headers: ownerHeaders });
              const state = (await status.json()).job as { status: string; items: { url: string; downloadUrl: string | null }[] };
              if (state.status === 'ready') {
                sources = state.items.filter((item) => item.downloadUrl).map((item) => ({ url: item.url, downloadUrl: item.downloadUrl!, format: 'best', kind: audioOnly ? 'audio' : 'video' }));
                result.bulk = state;
                break;
              }
              if (['failed', 'cancelled'].includes(state.status) || Date.now() > deadline) throw new Error(`Bulk preparation failed: ${JSON.stringify(state)}`);
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
          result.downloads = [];
          for (const [index, source] of sources.entries()) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 180_000);
            try {
              const query = new URLSearchParams({ url: source.url, formatId: source.format, kind: source.kind, mode: prepare ? 'prepare' : 'auto' });
              const response = await fetch(source.downloadUrl ? `${base}${source.downloadUrl}` : `${base}/api/v1/stream?${query}`, { signal: controller.signal, headers: ownerHeaders });
              if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${await response.text()}`);
              const chunks: Uint8Array[] = [];
              let bytes = 0;
              for await (const chunk of response.body!) {
                bytes += chunk.length;
                if (bytes > 80 * 1024 * 1024) {
                  controller.abort();
                  throw new Error('Test download exceeds 80 MiB; completion unverified.');
                }
                chunks.push(chunk);
              }
              if (!bytes) throw new Error('Empty download');
              const file = path.join(directory, `${sample.name}-${index}.media`);
              fs.writeFileSync(file, Buffer.concat(chunks));
              const probe = spawnSync(env.FFPROBE_PATH, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
              if (probe.status !== 0) throw new Error(`Media probe failed: ${probe.stderr}`);
              const details = JSON.parse(probe.stdout) as { streams?: { codec_type: string }[]; format?: { duration?: string } };
              if (!details.streams?.some((stream) => stream.codec_type === source.kind)) throw new Error(`No ${source.kind} stream in downloaded media`);
              (result.downloads as unknown[]).push({ bytes, mode: response.headers.get('x-blazfetch-mode'), format: source.format, probe: details });
            } finally { clearTimeout(timer); }
          }
        }
        result.status = 'passed';
      } catch (error) {
        result.status = 'failed';
        result.error = (error as Error).message;
        process.exitCode = 1;
      }
      result.ms = Date.now() - started;
      results.push(result);
      console.log(JSON.stringify(result));
      fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await getDb().close();
  }
}

function fixtureUrl(name: string): string {
  const override = process.argv.find((arg) => arg.startsWith(`--url-${name}=`));
  if (override) return override.slice(name.length + 7);
  if (name === 'newgrounds') return 'https://www.newgrounds.com/audio/listen/549479';
  if (name === 'tumblr') return 'https://maskofthedragon.tumblr.com/post/626907179849564160/mona-talking-in-english';
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/examples', `${name}.json`), 'utf8')) as { request: { body: { url: string } } };
  return fixture.request.body.url;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
