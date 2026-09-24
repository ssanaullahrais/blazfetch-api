import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateAndNormalizeUrl } from '../src/utils/url';
import { getAdapter } from '../src/core/adapters/registry';
import { validateMediaFile, isBrowserCompatibleMp4 } from '../src/core/ffmpeg/ffprobe';
import { runFfmpeg, transcodeToCompatibleMp4Args, extractAudioArgs } from '../src/core/ffmpeg/ffmpegRunner';
import { pickBestVideoFormat, pickBestAudioFormat } from '../src/core/adapters/formatSelection';

const keepDir = path.join(process.cwd(), 'tmp', 'full-download-output');

const CASES: { label: string; slug: string; url: string; kind: 'video' | 'audio'; preferHeightMax?: number }[] = [
  { label: 'YouTube', slug: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', kind: 'video' },
  { label: 'TikTok', slug: 'tiktok', url: 'https://www.tiktok.com/@scout2015/video/6718335390845095173', kind: 'video' },
  { label: 'Instagram', slug: 'instagram', url: 'https://www.instagram.com/p/DdWcvWnoECL/?hl=en', kind: 'video' },
  { label: 'X-Twitter', slug: 'x-twitter', url: 'https://x.com/TheoVon/status/1916982720317821050', kind: 'video' },
  { label: 'Facebook', slug: 'facebook', url: 'https://www.facebook.com/reel/1097374499488415', kind: 'video' },
  { label: 'Reddit', slug: 'reddit', url: 'https://www.reddit.com/r/funny/comments/1bx4vqy/in_hot_pursuit/', kind: 'video' },
  { label: 'Vimeo', slug: 'vimeo', url: 'https://vimeo.com/879829092', kind: 'video' },
  { label: 'Dailymotion', slug: 'dailymotion', url: 'https://www.dailymotion.com/video/xa6x0vw', kind: 'video' },
  { label: 'Bluesky', slug: 'bluesky', url: 'https://bsky.app/profile/bsky.app/post/3mtwf7gxkwc2r', kind: 'video' },
  { label: 'Streamable', slug: 'streamable', url: 'https://streamable.com/hn8hq', kind: 'video' },
  { label: 'Rutube', slug: 'rutube', url: 'https://rutube.ru/video/private/caafe83ff1c6ed38d394635b83ece578/?p=IBgzQQrKH4qB1bqm_91x7Q', kind: 'video' },
  { label: 'SoundCloud', slug: 'soundcloud', url: 'https://soundcloud.com/nasa/houston-we-have-a-podcast-4', kind: 'audio' },
  { label: 'Snapchat', slug: 'snapchat', url: 'https://www.snapchat.com/p/8af53eee-e298-40c4-9d6e-af20cf881b61/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYYnlvaXl5amp6AZ1H3xfEAZ1H2YQIAAAAAQ', kind: 'video' },
  { label: 'Twitch', slug: 'twitch', url: 'https://www.twitch.tv/videos/2702797838', kind: 'video', preferHeightMax: 480 },
  { label: 'Pinterest', slug: 'pinterest', url: 'https://www.pinterest.com/pin/664281013778109217/', kind: 'video' },
];

async function runVideo(c: typeof CASES[number]) {
  const normalized = validateAndNormalizeUrl(c.url);
  const adapter = getAdapter(normalized);
  const metadata = await adapter.fetchMetadata({ requestId: 'dlall', normalizedUrl: normalized });

  let best;
  if (c.preferHeightMax) {
    const candidates = metadata.formats.filter((f) => (f.height ?? 9999) <= c.preferHeightMax!);
    best = pickBestVideoFormat(candidates.length ? candidates : metadata.formats);
  } else {
    best = pickBestVideoFormat(metadata.formats);
  }
  if (!best) throw new Error('no video format found');

  const outputDir = path.join(os.tmpdir(), `blazfetch-dlall-${c.slug}-${Date.now()}`);
  const controller = new AbortController();
  const formatSelector = best.requiresMerge
    ? `${best.formatId}+bestaudio[acodec^=mp4a]/${best.formatId}+bestaudio/best`
    : best.formatId;

  const result = await adapter.download(
    { requestId: 'dlall', normalizedUrl: normalized },
    { formatId: formatSelector, kind: 'video', outputDir, signal: controller.signal, onProgress: (p) => process.stdout.write(`\r  ${c.label}: ${p.percent?.toFixed(0) ?? '?'}%   `) },
  );

  let finalPath: string;
  let mimeType: string;
  if (result.directUrl) {
    // Direct-CDN-URL platforms (fallback paths): actually pull the bytes down for this batch
    // since the goal here is a saved local file, not just a verified reachable URL.
    const res = await fetch(result.directUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    finalPath = path.join(outputDir, `${c.slug}-raw.mp4`);
    await fs.promises.mkdir(outputDir, { recursive: true });
    await fs.promises.writeFile(finalPath, buf);
    mimeType = 'video/mp4';
  } else {
    finalPath = result.filePath;
    mimeType = result.mimeType;
  }

  let validation = await validateMediaFile(finalPath, 'video');
  if (!isBrowserCompatibleMp4(validation)) {
    const compatiblePath = path.join(outputDir, 'compatible.mp4');
    await runFfmpeg({ args: transcodeToCompatibleMp4Args(finalPath, compatiblePath), signal: controller.signal });
    finalPath = compatiblePath;
    validation = await validateMediaFile(finalPath, 'video');
  }

  const keptPath = path.join(keepDir, `${c.slug}.mp4`);
  await fs.promises.copyFile(finalPath, keptPath);
  const stat = await fs.promises.stat(keptPath);
  await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => {});

  return { ok: true, path: keptPath, sizeKB: Math.round(stat.size / 1024), validation };
}

async function runAudio(c: typeof CASES[number]) {
  const normalized = validateAndNormalizeUrl(c.url);
  const adapter = getAdapter(normalized);
  const metadata = await adapter.fetchMetadata({ requestId: 'dlall', normalizedUrl: normalized });
  const best = pickBestAudioFormat(metadata.audioFormats);
  if (!best) throw new Error('no audio format found');

  const outputDir = path.join(os.tmpdir(), `blazfetch-dlall-${c.slug}-${Date.now()}`);
  const controller = new AbortController();
  const result = await adapter.download(
    { requestId: 'dlall', normalizedUrl: normalized },
    { formatId: best.formatId, kind: 'audio', outputDir, signal: controller.signal },
  );

  const finalPath = result.filePath;
  const validation = await validateMediaFile(finalPath, 'audio');
  const keptPath = path.join(keepDir, `${c.slug}.${result.filename.split('.').pop()}`);
  await fs.promises.copyFile(finalPath, keptPath);
  const stat = await fs.promises.stat(keptPath);
  await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => {});

  return { ok: true, path: keptPath, sizeKB: Math.round(stat.size / 1024), validation };
}

async function main() {
  await fs.promises.mkdir(keepDir, { recursive: true });
  const results: { label: string; ok: boolean; detail: string }[] = [];

  for (const c of CASES) {
    console.log(`\n=== ${c.label} ===`);
    try {
      const r = c.kind === 'audio' ? await runAudio(c) : await runVideo(c);
      console.log(`\nOK -> ${r.path} (${r.sizeKB} KB)`, r.validation);
      results.push({ label: c.label, ok: true, detail: `${r.sizeKB} KB, ${r.path}` });
    } catch (err) {
      console.log('FAIL:', (err as Error).message);
      results.push({ label: c.label, ok: false, detail: (err as Error).message });
    }
  }

  console.log('\n\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label} | ${r.detail}`);
}

main();
