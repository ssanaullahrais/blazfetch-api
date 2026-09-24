# Blazfetch Backend

## What is this?

Blazfetch is a backend server that lets an app (a website, a mobile app, whatever you build)
grab videos, photos, and audio from social media links — paste in a YouTube, TikTok, Instagram,
Pinterest, etc. link, and it figures out what's in it and lets you download it.

It never keeps a permanent copy of anyone's videos on its own server. It just looks up the media,
prepares the download, and streams the file straight through to whoever asked for it — then
cleans up after itself.

## What platforms work right now

"Confirmed" means we actually tested it with a real link and checked the downloaded file plays
correctly (not broken, not black-screen, has sound when it should).

| Platform | Status | Notes |
|---|---|---|
| YouTube | ✅ Confirmed | Video, playlists (flat listing), best-quality auto-select |
| TikTok | ✅ Confirmed | yt-dlp primary, `@tobyg74/tiktok-api-dl` fallback |
| Instagram | ✅ Confirmed (single post/reel/carousel) | Profile listing needs a session — see below |
| X / Twitter | ✅ Confirmed | Both `x.com` and legacy `twitter.com` |
| Facebook | ✅ Confirmed | Reels |
| Reddit | ✅ Confirmed | Including separate video+audio DASH streams |
| Vimeo | ✅ Confirmed | Auto-retries via the embed/player URL when the watch page requires login |
| Dailymotion | ✅ Confirmed | Some clips have no audio track at the source — not a bug |
| Bluesky | ✅ Confirmed | |
| Streamable | ✅ Confirmed | |
| Rutube | ✅ Confirmed | |
| SoundCloud | ✅ Confirmed (single track) | Profile/browse pages (e.g. `/discover`) rejected with a clear error instead of hanging |
| Snapchat | ✅ Confirmed | Uses yt-dlp's generic HTML5-embed extractor |
| Twitch | ✅ Confirmed | VODs, including 50+ minute recordings |
| Pinterest | ✅ Confirmed (pins + boards) | Public `PinResource`/`BoardResource` API, no auth needed — see below |
| Loom, Newgrounds, Tumblr | ⚠️ Wired, untested | No real test URL exercised yet; Newgrounds correctly blocks age-restricted content |
| Instagram (profile listing) | ⚠️ Requires your own session | See "Instagram profile listing" below |

## Getting it running (short version)

You'll need these installed first:
- Node.js (version 20 or newer)
- PostgreSQL (a database)
- yt-dlp (the tool that actually knows how to pull media from each platform)
- ffmpeg (converts/merges video and audio so files play properly everywhere)

Then:

```bash
npm install
cp .env.example .env
# open .env and fill in DATABASE_URL (where your database is)
npm run migrate
npm run diagnostics
npm run dev
```

`npm run diagnostics` just checks that everything above is actually installed and reachable
before you try to run the real server — it'll tell you plainly what's missing if something is.

The server will refuse to start at all if the database, yt-dlp, or ffmpeg aren't found, so you
won't get a confusing half-broken server — you'll know immediately what to fix.

Full step-by-step deployment instructions (for putting this on a real server, not just your own
computer) are in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## The basic idea of how it works

1. Someone sends a link (e.g. a YouTube URL) to the server.
2. The server checks the link is safe and figures out which platform it's from.
3. It asks the right tool (usually yt-dlp) to look up what's actually in that link — the title,
   thumbnail, and every quality/format available.
4. It hands that back as one consistent, easy-to-use response, no matter which platform it came
   from — your app doesn't need to know or care whether it was YouTube or TikTok underneath.
5. When someone wants to actually download it, the server fetches it, makes sure it's a working
   file (checks it isn't broken or silent when it shouldn't be), and streams it straight to them.

## If a download comes out broken (black screen, no sound, etc.)

This was a real problem we fixed: it's possible for a video file to "finish downloading"
successfully and still be broken — wrong video format, missing audio, a corrupted merge. So
every video that comes out of this server is double-checked afterward with a tool (`ffprobe`)
that actually looks inside the file and confirms: does it have a real video track? Real audio (if
it's supposed to)? A sensible length? If the file isn't in a widely-compatible format, it gets
automatically converted before being handed over — so what you get back is something that will
actually open and play, not just a file that technically exists.

## For developers

The rest of this document goes into technical detail. If you're building the actual app on top
of this backend, start with [docs/API.md](docs/API.md) — it has every API endpoint with example
requests and responses, plus a quick "how do I wire this into a frontend" walkthrough.

### Architecture

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
`GenericYtDlpAdapter` directly; YouTube, TikTok, Instagram, Vimeo, and Pinterest have dedicated
adapters for playlist listing, carousel handling, fallback providers, embed-URL rewriting, and
board/collection support respectively. Adding a new platform means adding a domain to
`src/constants/platforms.ts` and, if it needs special handling, a new adapter — the rest of the
app (routes, jobs, caching, stats) is unaware of which extractor is behind an adapter.

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

### Supported platform list

See the platform status table near the top of this document (same table, kept in one place to
avoid drift). `GET /api/v1/platforms` returns the live list with domains.

Pinterest supports both individual pins (`/pin/<id>`) and full boards (`/<user>/<board>`) via
Pinterest's own public `PinResource`/`BoardResource` API — no authentication needed, and images
are downloaded at Pinterest's actual highest resolution (`orig`), not a grid thumbnail. Large
boards can be fetched in slices with `rangeStart`/`rangeEnd` — see [docs/API.md](docs/API.md).

### System requirements

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

### Production

```bash
npm ci
npm run build
npm run migrate
npm start
```

For a full VPS deployment walkthrough (Nginx, PM2, SSL, firewall, yt-dlp updates), see
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

### Updating yt-dlp

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

### API

See [docs/API.md](docs/API.md) for full endpoint documentation, or `docs/openapi.yaml` for the
OpenAPI 3.0 spec.

Quick reference:

```
POST   /api/v1/fetch            resolve metadata + video/image formats (rangeStart/rangeEnd for boards)
POST   /api/v1/fetch/audio      resolve audio/MP3 options
POST   /api/v1/download         start a download job (formatId defaults to "best")
GET    /api/v1/downloads/:id    stream the resolved media once the job is ready
DELETE /api/v1/downloads/:id    cancel a download and clean up its temp files
GET    /api/v1/jobs/:id         poll job status/progress
DELETE /api/v1/jobs/:id         cancel a job
GET    /api/v1/platforms        list supported platforms + domains
GET    /health                  liveness
GET    /health/ready            readiness (DB, yt-dlp, ffmpeg, instaloader)
```

`formatId` on `/download` can be omitted (or set to `"best"`) to automatically get the highest
resolution for video or highest-bitrate audio — no need to enumerate formats first just to get
a sensible default.

### Download correctness (avoiding broken/black output)

Every video download is validated with `ffprobe` after it's produced — a completed yt-dlp/ffmpeg
process is not treated as proof the file is playable. If a merged/remuxed file isn't using a
broadly compatible codec pair (H.264 video / AAC audio), it's transcoded before being marked
`completed` rather than handed back as a technically-finished-but-broken file. See
`src/core/ffmpeg/ffprobe.ts` and `ensureValidAndCompatible` in `src/services/downloadService.ts`.

### Testing

```bash
npm test
```

Unit tests cover URL validation/normalization (SSRF protocol rejection, platform whitelist,
per-platform canonicalization including Pinterest boards/pins and SoundCloud track vs. profile
detection), yt-dlp format normalization (including the generic/HTML5-embed extractor's null-codec
handling that Snapchat needs), and best-format selection.

15 of 18 platforms have additionally been verified with real end-to-end downloads (metadata →
merge/transcode → ffprobe validation) against live URLs — see the platform table above and
[docs/API.md](docs/API.md) for what "confirmed" means concretely. Platform adapters that shell
out to yt-dlp/ffmpeg or call fallback providers are best exercised against a real Linux/VPS-like
environment with those binaries installed — see docs/REQUIREMENTS.md for the recommended test
matrix per platform.

### Troubleshooting

- `npm run diagnostics` — prints Node/PostgreSQL/yt-dlp/ffmpeg/ffprobe status and versions.
- `GET /health/ready` — same checks, over HTTP, for use as a deploy/orchestrator gate.
- yt-dlp extractor failures are logged with full stderr internally but returned to clients as a
  normalized error code (`EXTRACTOR_FAILED`, `PRIVATE_MEDIA`, `LOGIN_REQUIRED`, etc.) — check the
  server logs for the raw extractor message.
