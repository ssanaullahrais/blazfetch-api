import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const boolFromString = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true'));

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().default('http://localhost:4000'),
  LOG_LEVEL: z.string().default('info'),

  // DATABASE_DRIVER picks the storage backend. All four store the exact same data (metadata
  // cache, jobs, fetch/download stats) — never the downloaded media itself — through one shared
  // repository interface (src/db/types.ts), so the rest of the app never knows which one is active.
  DATABASE_DRIVER: z.enum(['postgres', 'mysql', 'sqlite', 'mongodb']).default('sqlite'),
  // Connection string for postgres/mysql/mongodb. Not required for sqlite (uses DATABASE_SQLITE_PATH).
  DATABASE_URL: z.string().optional().default(''),
  DATABASE_SSL: boolFromString(false),
  // File path for the sqlite driver only, e.g. ./data/blazfetch.sqlite3. Created automatically.
  DATABASE_SQLITE_PATH: z.string().default('./data/blazfetch.sqlite3'),

  YTDLP_PATH: z.string().default('yt-dlp'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  FETCH_TIMEOUT_MS: z.coerce.number().default(25000),
  REDIRECT_RESOLVE_TIMEOUT_MS: z.coerce.number().default(8000),
  FALLBACK_TIMEOUT_MS: z.coerce.number().default(15000),
  DOWNLOAD_START_TIMEOUT_MS: z.coerce.number().default(15000),
  DOWNLOAD_TOTAL_TIMEOUT_MS: z.coerce.number().default(600000),
  FFMPEG_TIMEOUT_MS: z.coerce.number().default(180000),
  PROXY_STREAM_TIMEOUT_MS: z.coerce.number().default(600000),

  MAX_CONCURRENT_DOWNLOADS_GLOBAL: z.coerce.number().default(10),
  MAX_CONCURRENT_DOWNLOADS_PER_USER: z.coerce.number().default(2),
  MAX_CONCURRENT_DOWNLOADS_PER_GUEST: z.coerce.number().default(1),
  MAX_CONCURRENT_FETCHES_GLOBAL: z.coerce.number().default(20),

  MAX_PLAYLIST_ITEMS: z.coerce.number().default(200),
  MAX_DOWNLOAD_SIZE_BYTES: z.coerce.number().default(2147483648),
  TEMP_DIR: z.string().default('./tmp'),
  // GET /api/v1/stream pipes yt-dlp/ffmpeg output straight to the client with no temp file. Set to
  // false to disable the endpoint (POST /download -> /downloads/:id keeps working either way).
  STREAM_MODE_ENABLED: boolFromString(true),

  // Cloudflare Turnstile (bot check). Off by default. When on, fetch/stream/download need a passed check.
  TURNSTILE_ENABLED: boolFromString(false),
  TURNSTILE_SITE_KEY: z.string().optional().default(''),
  TURNSTILE_SECRET_KEY: z.string().optional().default(''),
  // How long a passed check keeps working before the visitor is asked again (seconds).
  TURNSTILE_SESSION_SECONDS: z.coerce.number().default(1800),
  // Optional: secret used to sign the pass cookie. Defaults to one derived from TURNSTILE_SECRET_KEY.
  TURNSTILE_COOKIE_SECRET: z.string().optional().default(''),
  // Delivery mode for GET /api/v1/stream when the request has no ?mode=: "stream" pipes straight through,
  // "prepare" builds the file on the server first, "auto" tries stream and falls back to prepare.
  DEFAULT_DOWNLOAD_MODE: z.enum(['stream', 'prepare', 'auto']).default('stream'),
  // How old (ms) a file/folder in TEMP_DIR must be before the periodic sweep deletes it.
  TEMP_SWEEP_MAX_AGE_MS: z.coerce.number().default(3600000),
  TEMP_SWEEP_INTERVAL_MS: z.coerce.number().default(600000),

  // How long the direct media URLs inside a stored response are trusted (they expire at the source).
  // Everything else about a stored item is kept forever; see the REVALIDATE_* settings.
  CACHE_TTL_SECONDS: z.coerce.number().default(3600),
  // Playlists change, so a stored playlist is refreshed after this long (YouTube Mixes use CACHE_TTL_SECONDS).
  PLAYLIST_REFRESH_SECONDS: z.coerce.number().default(86400),
  // Every stored item is re-checked (does it still exist?) this often, both by the background job and
  // on demand when a user requests an item that is due.
  REVALIDATE_AFTER_SECONDS: z.coerce.number().default(604800),
  REVALIDATE_ENABLED: boolFromString(true),
  REVALIDATE_INTERVAL_MS: z.coerce.number().default(1800000),
  REVALIDATE_BATCH_SIZE: z.coerce.number().default(10),
  // Pause between two checks in the background job so source sites are never hammered.
  REVALIDATE_DELAY_MS: z.coerce.number().default(3000),
  // Consecutive "not found / private" answers before an item is marked unavailable (one flaky 404 is not enough).
  UNAVAILABLE_AFTER_FAILURES: z.coerce.number().default(2),
  // After a timeout or rate limit, try again after this long. After a "gone" answer below the threshold, 1 day.
  TRANSIENT_RETRY_SECONDS: z.coerce.number().default(3600),
  // A user re-requesting a known-unavailable item is not re-extracted more often than this.
  UNAVAILABLE_RECHECK_SECONDS: z.coerce.number().default(600),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_GUEST: z.coerce.number().default(30),
  RATE_LIMIT_MAX_USER: z.coerce.number().default(120),
  RATE_LIMIT_MAX_DOWNLOAD: z.coerce.number().default(10),

  INSTAGRAM_FALLBACK_MAX_RETRIES: z.coerce.number().default(3),
  INSTAGRAM_FALLBACK_RETRY_DELAY_MS: z.coerce.number().default(1000),
  // Optional: path to a Netscape-format cookies.txt exported from a browser logged into the
  // Instagram account whose own content this deployment is authorized to access. Never fetched
  // or generated by the backend itself — the operator supplies their own exported session.
  INSTAGRAM_COOKIES_PATH: z.string().optional().default(''),

  // YouTube blocks an IP for a while when it sees many requests ("Sign in to confirm you're not a bot").
  // When yt-dlp fails that way, the fallback provider (btch-downloader) serves the request instead.
  YOUTUBE_FALLBACK_ENABLED: boolFromString(true),
  YOUTUBE_FALLBACK_ATTEMPTS: z.coerce.number().default(2),
  // After a bot check, skip yt-dlp for YouTube for this long and use the fallback directly, so we stop
  // hammering YouTube (which would only extend the block).
  YOUTUBE_BLOCK_COOLDOWN_SECONDS: z.coerce.number().default(600),
  // Direct links handed out by fallback providers (btch-downloader, ...) die within a minute or so, so a
  // stored answer that came from one is trusted for this long only (yt-dlp's own links use CACHE_TTL_SECONDS).
  FALLBACK_LINK_TTL_SECONDS: z.coerce.number().default(30),
  CAKKATROK_MAX_ATTEMPTS: z.coerce.number().default(1),
  CAKKATROK_API_BASE: z.string().optional().default(''),

  CORS_ALLOWED_ORIGINS: z.string().default('*'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
