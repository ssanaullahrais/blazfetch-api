# Blazfetch Backend

Backend API for Blazfetch: resolves media metadata, available formats, and orchestrates
downloads from supported social platforms. Node.js + Express + PostgreSQL, with yt-dlp as the
primary extraction engine.

The API server never permanently stores downloaded media. It resolves sources, tracks jobs and
statistics, and streams media directly from the source/CDN to the client (or briefly through a
proxy when the client can't reach the source URL directly), cleaning up any temp files it used
along the way.

## Architecture

```
API Request
    ↓
URL Validation (SSRF-safe) + Normalization
    ↓
Platform Detection (domain whitelist)
    ↓
Platform Adapter (implements fetchMetadata / download)
    ↓
yt-dlp (primary) or platform-specific fallback provider
    ↓
Normalized Blazfetch Response
```

Every platform is implemented as a `PlatformAdapter` (`src/core/adapters/`). Most platforms use
`GenericYtDlpAdapter` directly; YouTube, TikTok, Instagram, and Vimeo have dedicated adapters for
playlist listing, carousel handling, fallback providers, and embed-URL rewriting respectively.
Adding a new platform means adding a domain to `src/constants/platforms.ts` and, if it needs
special handling, a new adapter — the rest of the app (routes, jobs, caching, stats) is unaware
of which extractor is behind an adapter.

```
src/
  config/       env loading & validation (zod)
  constants/    platform whitelist, error codes
  lib/          logger, mime lookup, dependency checks
  db/           pg pool, SQL migrations, migration runner
  middleware/   request id/guest id, error handler, rate limiting, validation
  utils/        URL validation/normalization, SSRF guard, asyncHandler
  core/
    adapters/   PlatformAdapter interface + implementations + registry
    ytdlp/      yt-dlp child_process runner (metadata + download w/ progress)
    ffmpeg/     ffmpeg (merge/transcode/extract-audio) + ffprobe validation
    cache/      Postgres-backed metadata cache
    jobs/       job manager, concurrency limiter, temp file cleanup
    fallback/   TikTok (@tobyg74/tiktok-api-dl), Instagram (btch-downloader, cakkatrok, Instaloader),
                Pinterest (public PinResource/BoardResource API) fallbacks
  services/     fetchService, audioService, downloadService, statsService
  controllers/  thin HTTP handlers
  routes/       versioned route definitions
```

## Supported platforms

YouTube, TikTok, Instagram, X/Twitter, Facebook, Vimeo, Reddit, SoundCloud, Pinterest, Snapchat,
Dailymotion, Bluesky, Loom, Newgrounds, Rutube, Streamable, Twitch, Tumblr. See
`GET /api/v1/platforms` for the live list with supported domains.

## System requirements

- Node.js >= 20
- PostgreSQL >= 14
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on PATH (or set `YTDLP_PATH`)
- ffmpeg + ffprobe on PATH (or set `FFMPEG_PATH` / `FFPROBE_PATH`)

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for full VPS deployment requirements.

### Instagram profile listing (optional)

Single Instagram posts/reels/carousels work anonymously out of the box. Listing a profile's
posts requires an authenticated session — Instagram returns `401 require_login` on that endpoint
for anonymous requests, even for public accounts. To enable it:

```bash
pip install instaloader
instaloader --login <your_username>   # creates a session file; you do this yourself, once
```

Then set in `.env`:

```
PYTHON_PATH=python
INSTAGRAM_INSTALOADER_SESSION_PATH=/path/to/the/session/file
INSTAGRAM_INSTALOADER_SESSION_USERNAME=<your_username>
```

The backend never requests, stores, or generates Instagram credentials itself — it only loads a
session you already created outside of it, exactly like Instaloader's own `--login` flow is
meant to be used for content that account has legitimate access to. Without this configured,
`POST /fetch` on a profile URL returns a clear `LOGIN_REQUIRED` error instead of a broken result.

## Installation (development)

```bash
npm install
cp .env.example .env
# edit .env: DATABASE_URL at minimum
npm run migrate
npm run diagnostics   # verifies node/postgres/yt-dlp/ffmpeg/ffprobe are all reachable
npm run dev
```

The server starts on `http://localhost:4000` by default. It refuses to start if PostgreSQL,
yt-dlp, ffmpeg, or ffprobe aren't reachable — check the startup log for which one failed.

## Production

```bash
npm ci
npm run build
npm run migrate
npm start
```

For a full VPS deployment walkthrough (Nginx, PM2, SSL, firewall, yt-dlp updates), see
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Updating yt-dlp

Social platforms change frequently enough that yt-dlp needs regular updates independent of a
backend redeploy:

```bash
# if installed via pip
pip install -U yt-dlp

# if installed as a standalone binary
yt-dlp -U
```

Confirm the active version anytime with:

```bash
yt-dlp --version
```

or `npm run diagnostics`, which prints it alongside the rest of the environment.

## API

See [docs/API.md](docs/API.md) for full endpoint documentation, or `docs/openapi.yaml` for the
OpenAPI 3.0 spec.

Quick reference:

```
POST   /api/v1/fetch            resolve metadata + video/image formats
POST   /api/v1/fetch/audio      resolve audio/MP3 options
POST   /api/v1/download         start a download job (returns a job id)
GET    /api/v1/downloads/:id    stream the resolved media once the job is ready
DELETE /api/v1/downloads/:id    cancel a download and clean up its temp files
GET    /api/v1/jobs/:id         poll job status/progress
DELETE /api/v1/jobs/:id         cancel a job
GET    /api/v1/platforms        list supported platforms + domains
GET    /health                  liveness
GET    /health/ready            readiness (DB, yt-dlp, ffmpeg)
```

## Download correctness (avoiding broken/black output)

Every video download is validated with `ffprobe` after it's produced — a completed yt-dlp/ffmpeg
process is not treated as proof the file is playable. If a merged/remuxed file isn't using a
broadly compatible codec pair (H.264 video / AAC audio), it's transcoded before being marked
`completed` rather than handed back as a technically-finished-but-broken file. See
`src/core/ffmpeg/ffprobe.ts` and `ensureValidAndCompatible` in `src/services/downloadService.ts`.

## Testing

```bash
npm test
```

Unit tests currently cover URL validation/normalization (SSRF protocol rejection, platform
whitelist, per-platform canonicalization) and yt-dlp format normalization. Platform adapters that
shell out to yt-dlp/ffmpeg or call fallback providers are best exercised against a real
Linux/VPS-like environment with those binaries installed — see docs/REQUIREMENTS.md for the
recommended test matrix per platform.

## Troubleshooting

- `npm run diagnostics` — prints Node/PostgreSQL/yt-dlp/ffmpeg/ffprobe status and versions.
- `GET /health/ready` — same checks, over HTTP, for use as a deploy/orchestrator gate.
- yt-dlp extractor failures are logged with full stderr internally but returned to clients as a
  normalized error code (`EXTRACTOR_FAILED`, `PRIVATE_MEDIA`, `LOGIN_REQUIRED`, etc.) — check the
  server logs for the raw extractor message.
