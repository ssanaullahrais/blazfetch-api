import { z } from 'zod';
import dotenv from 'dotenv';

// Tests run on the built-in defaults: a server's own .env (Turnstile on, TRUST_PROXY, production mode) must not
// change what they check. Each test sets whatever it needs itself.
if (!process.env.VITEST) dotenv.config();

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
  // H.264 conversions (ffmpeg) are what can exhaust a small server's CPU and memory: at most this many run at once,
  // the rest wait their turn. 0 = half the CPU cores (at least 1).
  MAX_CONCURRENT_CONVERSIONS: z.coerce.number().int().min(0).default(0),
  // CPU threads per conversion. 0 = the cores divided between the conversions allowed at once.
  FFMPEG_THREADS: z.coerce.number().int().min(0).default(0),
  // yt-dlp/ffmpeg run at this lower priority (nice, 0-19) so the API keeps answering while they work. 0 = off.
  MEDIA_PROCESS_NICE: z.coerce.number().int().min(0).max(19).default(10),
  // A download that has to be prepared on disk is refused while TEMP_DIR has less free space than this.
  MIN_FREE_DISK_MB: z.coerce.number().int().min(0).default(1024),
  MAX_CONCURRENT_DOWNLOADS_PER_USER: z.coerce.number().default(2),
  MAX_CONCURRENT_DOWNLOADS_PER_GUEST: z.coerce.number().default(1),
  // Guests sharing one IP address (one /64 for IPv6), e.g. an office or a mobile carrier, share this many downloads.
  // Only applies when the real visitor IP is known (TRUST_PROXY set correctly behind a proxy).
  MAX_CONCURRENT_DOWNLOADS_PER_IP: z.coerce.number().default(5),
  MAX_CONCURRENT_FETCHES_GLOBAL: z.coerce.number().default(20),

  MAX_PLAYLIST_ITEMS: z.coerce.number().default(200),
  MAX_DOWNLOAD_SIZE_BYTES: z.coerce.number().default(2147483648),
  TEMP_DIR: z.string().default('./tmp'),
  // GET /api/v1/stream pipes yt-dlp/ffmpeg output straight to the client with no temp file. Set to
  // false to disable the endpoint (POST /download -> /downloads/:id keeps working either way).
  STREAM_MODE_ENABLED: boolFromString(true),
  // Every audio download is delivered as MP3: any source format that is not already MP3 is converted through
  // ffmpeg (piped live in stream mode, or a temporary file that is deleted after sending in prepare/job mode).
  AUDIO_FORCE_MP3: boolFromString(false),

  // Cloudflare Turnstile (bot check). Off by default. When on, fetch/stream/download need a passed check.
  TURNSTILE_ENABLED: boolFromString(false),
  TURNSTILE_SITE_KEY: z.string().optional().default(''),
  TURNSTILE_SECRET_KEY: z.string().optional().default(''),
  // How long a passed check keeps working before the visitor is asked again (seconds).
  TURNSTILE_SESSION_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
  // Optional extra Siteverify checks. Hostnames contain no scheme or port; action must match the widget.
  TURNSTILE_ALLOWED_HOSTNAMES: z.string().default(''),
  TURNSTILE_EXPECTED_ACTION: z.string().regex(/^[a-zA-Z0-9_-]{0,32}$/).default(''),
  // Optional: secret used to sign the pass cookie. Defaults to one derived from TURNSTILE_SECRET_KEY.
  TURNSTILE_COOKIE_SECRET: z.string().optional().default(''),
  // Delivery mode for GET /api/v1/stream when the request has no ?mode=: "stream" pipes straight through,
  // "prepare" builds the file on the server first, "auto" tries stream and falls back to prepare.
  DEFAULT_DOWNLOAD_MODE: z.enum(['stream', 'prepare', 'auto']).default('stream'),
  // How old (ms) a file/folder in TEMP_DIR must be before the periodic sweep deletes it.
  TEMP_SWEEP_MAX_AGE_MS: z.coerce.number().default(3600000),
  TEMP_SWEEP_INTERVAL_MS: z.coerce.number().default(600000),

  // A visitor counts as "online" in the public stats while a GET /stats/events connection has touched
  // presence within this long. The live-stats heartbeat (15s) keeps it fresh for as long as the tab stays
  // open; this only needs to comfortably outlast a couple of missed heartbeats, not model a real timeout.
  ONLINE_VISITOR_WINDOW_SECONDS: z.coerce.number().default(60),

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
  // Per-IP ceiling = this many times the per-visitor limit (bounds a client that keeps dropping its guest cookie).
  RATE_LIMIT_IP_MULTIPLIER: z.coerce.number().int().min(1).default(10),

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
  // Number of reverse proxies in front of the app (1 behind Nginx). Leave 0 when clients connect directly: trusting
  // X-Forwarded-For without a proxy would let anyone fake their IP.
  TRUST_PROXY: z.coerce.number().default(0),
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
