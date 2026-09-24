import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateAndNormalizeUrl } from '../src/utils/url';
import { getAdapter } from '../src/core/adapters/registry';
import { validateMediaFile, isBrowserCompatibleMp4 } from '../src/core/ffmpeg/ffprobe';
import { runFfmpeg, transcodeToCompatibleMp4Args, extractAudioArgs } from '../src/core/ffmpeg/ffmpegRunner';
import { pickBestVideoFormat, pickBestAudioFormat } from '../src/core/adapters/formatSelection';

const keepDir = path.join(process.cwd(), 'tmp', 'full-download-output');

const VIDEO_CASES: { label: string; slug: string; url: string; preferHeightMax?: number }[] = [
  { label: 'YouTube', slug: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  { label: 'TikTok', slug: 'tiktok', url: 'https://www.tiktok.com/@scout2015/video/6718335390845095173' },
  { label: 'Instagram', slug: 'instagram', url: 'https://www.instagram.com/p/DdWcvWnoECL/?hl=en' },
  { label: 'X-Twitter', slug: 'x-twitter', url: 'https://x.com/TheoVon/status/1916982720317821050' },
  { label: 'Facebook', slug: 'facebook', url: 'https://www.facebook.com/reel/1097374499488415' },
  { label: 'Reddit', slug: 'reddit', url: 'https://www.reddit.com/r/funny/comments/1bx4vqy/in_hot_pursuit/' },
  { label: 'Vimeo', slug: 'vimeo', url: 'https://vimeo.com/879829092' },
  { label: 'Dailymotion', slug: 'dailymotion', url: 'https://www.dailymotion.com/video/xa6x0vw' },
  { label: 'Bluesky', slug: 'bluesky', url: 'https://bsky.app/profile/bsky.app/post/3mtwf7gxkwc2r' },
  { label: 'Streamable', slug: 'streamable', url: 'https://streamable.com/hn8hq' },
  { label: 'Rutube', slug: 'rutube', url: 'https://rutube.ru/video/private/caafe83ff1c6ed38d394635b83ece578/?p=IBgzQQrKH4qB1bqm_91x7Q' },
  { label: 'Snapchat', slug: 'snapchat', url: 'https://www.snapchat.com/p/8af53eee-e298-40c4-9d6e-af20cf881b61/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYYnlvaXl5amp6AZ1H3xfEAZ1H2YQIAAAAAQ' },
  { label: 'Twitch', slug: 'twitch', url: 'https://www.twitch.tv/videos/2702797838', preferHeightMax: 480 },
  { label: 'Pinterest', slug: 'pinterest', url: 'https://www.pinterest.com/pin/664281013778109217/' },
];

async function downloadVideoAndAudio(c: typeof VIDEO_CASES[number]) {
  const normalized = validateAndNormalizeUrl(c.url);
  const adapter = getAdapter(normalized);
  const metadata = await adapter.fetchMetadata({ requestId: 'multi', normalizedUrl: normalized });

  // ---- VIDEO (best quality) ----
  const videoCandidates = c.preferHeightMax ? metadata.formats.filter((f) => (f.height ?? 9999) <= c.preferHeightMax!) : metadata.formats;
  const bestVideo = pickBestVideoFormat(videoCandidates.length ? videoCandidates : metadata.formats);
  if (!bestVideo) throw new Error('no video format found');

  const videoOutDir = path.join(os.tmpdir(), `blazfetch-multi-v-${c.slug}-${Date.now()}`);
  const controller1 = new AbortController();
  const videoFormatSelector = bestVideo.requiresMerge
    ? `${bestVideo.formatId}+bestaudio[acodec^=mp4a]/${bestVideo.formatId}+bestaudio/best`
    : bestVideo.formatId;

  const videoResult = await adapter.download(
    { requestId: 'multi', normalizedUrl: normalized },
    { formatId: videoFormatSelector, kind: 'video', outputDir: videoOutDir, signal: controller1.signal },
  );

  let videoFinalPath: string;
  if (videoResult.directUrl) {
    const res = await fetch(videoResult.directUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.mkdir(videoOutDir, { recursive: true });
    videoFinalPath = path.join(videoOutDir, 'raw.mp4');
    await fs.promises.writeFile(videoFinalPath, buf);
  } else {
    videoFinalPath = videoResult.filePath;
  }

  let videoValidation = await validateMediaFile(videoFinalPath, 'video');
  if (!isBrowserCompatibleMp4(videoValidation)) {
    const compatiblePath = path.join(videoOutDir, 'compatible.mp4');
    await runFfmpeg({ args: transcodeToCompatibleMp4Args(videoFinalPath, compatiblePath), signal: controller1.signal });
    videoFinalPath = compatiblePath;
    videoValidation = await validateMediaFile(videoFinalPath, 'video');
  }
  const videoKeptPath = path.join(keepDir, `${c.slug}-video.mp4`);
  await fs.promises.copyFile(videoFinalPath, videoKeptPath);
  const videoStat = await fs.promises.stat(videoKeptPath);

  // ---- AUDIO (best native format, or extracted from the video we just validated) ----
  let audioKeptPath: string;
  let audioValidation;
  const bestAudio = pickBestAudioFormat(metadata.audioFormats);

  if (bestAudio) {
    const audioOutDir = path.join(os.tmpdir(), `blazfetch-multi-a-${c.slug}-${Date.now()}`);
    const controller2 = new AbortController();
    const audioResult = await adapter.download(
      { requestId: 'multi', normalizedUrl: normalized },
      { formatId: bestAudio.formatId, kind: 'audio', outputDir: audioOutDir, signal: controller2.signal },
    );
    let audioFinalPath: string;
    if (audioResult.directUrl) {
      const res = await fetch(audioResult.directUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.mkdir(audioOutDir, { recursive: true });
      audioFinalPath = path.join(audioOutDir, `raw.${bestAudio.ext}`);
      await fs.promises.writeFile(audioFinalPath, buf);
    } else {
      audioFinalPath = audioResult.filePath;
    }
    audioValidation = await validateMediaFile(audioFinalPath, 'audio');
    audioKeptPath = path.join(keepDir, `${c.slug}-audio.${path.extname(audioFinalPath).slice(1) || bestAudio.ext}`);
    await fs.promises.copyFile(audioFinalPath, audioKeptPath);
    await fs.promises.rm(audioOutDir, { recursive: true, force: true }).catch(() => {});
  } else {
    // No standalone audio track on the source — extract from the already-downloaded video, same
    // as the real audioService/downloadService MP3-conversion fallback would do.
    audioKeptPath = path.join(keepDir, `${c.slug}-audio.mp3`);
    await runFfmpeg({ args: extractAudioArgs(videoKeptPath, audioKeptPath), signal: controller1.signal });
    audioValidation = await validateMediaFile(audioKeptPath, 'audio');
  }
  const audioStat = await fs.promises.stat(audioKeptPath);

  await fs.promises.rm(videoOutDir, { recursive: true, force: true }).catch(() => {});

  return {
    video: { path: videoKeptPath, sizeKB: Math.round(videoStat.size / 1024), validation: videoValidation },
    audio: { path: audioKeptPath, sizeKB: Math.round(audioStat.size / 1024), validation: audioValidation, native: !!bestAudio },
  };
}

async function downloadSoundCloud() {
  const url = 'https://soundcloud.com/nasa/houston-we-have-a-podcast-4';
  const normalized = validateAndNormalizeUrl(url);
  const adapter = getAdapter(normalized);
  const metadata = await adapter.fetchMetadata({ requestId: 'multi', normalizedUrl: normalized });
  const best = pickBestAudioFormat(metadata.audioFormats);
  if (!best) throw new Error('no audio format found');

  const outputDir = path.join(os.tmpdir(), `blazfetch-multi-soundcloud-${Date.now()}`);
  const controller = new AbortController();
  const result = await adapter.download(
    { requestId: 'multi', normalizedUrl: normalized },
    { formatId: best.formatId, kind: 'audio', outputDir, signal: controller.signal },
  );
  const validation = await validateMediaFile(result.filePath, 'audio');
  const keptPath = path.join(keepDir, `soundcloud-audio.${result.filename.split('.').pop()}`);
  await fs.promises.copyFile(result.filePath, keptPath);
  const stat = await fs.promises.stat(keptPath);
  await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  return { path: keptPath, sizeKB: Math.round(stat.size / 1024), validation };
}

async function downloadPinterestBoardImages() {
  const url = 'https://www.pinterest.com/qadeerrais/watch24hrs/';
  const normalized = validateAndNormalizeUrl(url);
  const adapter = getAdapter(normalized);
  const metadata = await adapter.fetchMetadata({ requestId: 'multi', normalizedUrl: normalized, range: { start: 1, end: 10 } });

  const outDir = path.join(keepDir, 'pinterest-board-images');
  await fs.promises.mkdir(outDir, { recursive: true });
  let count = 0;
  for (const item of metadata.items ?? []) {
    if (item.type === 'image' && item.source) {
      const res = await fetch(item.source);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.writeFile(path.join(outDir, `${item.id}.jpg`), buf);
      count += 1;
    }
  }
  return { count, outDir };
}

async function main() {
  await fs.promises.mkdir(keepDir, { recursive: true });
  const results: { label: string; ok: boolean; detail: string }[] = [];

  for (const c of VIDEO_CASES) {
    console.log(`\n=== ${c.label} ===`);
    try {
      const r = await downloadVideoAndAudio(c);
      console.log(`video -> ${r.video.path} (${r.video.sizeKB} KB)`, r.video.validation);
      console.log(`audio -> ${r.audio.path} (${r.audio.sizeKB} KB, native=${r.audio.native})`, r.audio.validation);
      results.push({ label: c.label, ok: true, detail: `video ${r.video.sizeKB}KB, audio ${r.audio.sizeKB}KB (native=${r.audio.native})` });
    } catch (err) {
      console.log('FAIL:', (err as Error).message);
      results.push({ label: c.label, ok: false, detail: (err as Error).message });
    }
  }

  console.log('\n=== SoundCloud (audio-only platform) ===');
  try {
    const r = await downloadSoundCloud();
    console.log(`audio -> ${r.path} (${r.sizeKB} KB)`, r.validation);
    results.push({ label: 'SoundCloud', ok: true, detail: `audio ${r.sizeKB}KB` });
  } catch (err) {
    console.log('FAIL:', (err as Error).message);
    results.push({ label: 'SoundCloud', ok: false, detail: (err as Error).message });
  }

  console.log('\n=== Pinterest board images (highest quality, range 1-10) ===');
  try {
    const r = await downloadPinterestBoardImages();
    console.log(`${r.count} images -> ${r.outDir}`);
    results.push({ label: 'Pinterest board images', ok: true, detail: `${r.count} images -> ${r.outDir}` });
  } catch (err) {
    console.log('FAIL:', (err as Error).message);
    results.push({ label: 'Pinterest board images', ok: false, detail: (err as Error).message });
  }

  console.log('\n\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.label} | ${r.detail}`);
}

main();
