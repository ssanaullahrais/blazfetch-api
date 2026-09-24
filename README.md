# Blazfetch Backend

Backend API that resolves media (video/audio/images) from social platform links and streams
downloads to the client. No permanent storage of media — it resolves, downloads, validates, and
streams through, cleaning up temp files after.

## Platform status

| Platform | Status | Notes |
|---|---|---|
| YouTube | ✅ Confirmed | Video, playlists, best-quality auto-select |
| TikTok | ✅ Confirmed | yt-dlp primary, `@tobyg74/tiktok-api-dl` fallback |
| Instagram | ✅ Confirmed (single post/reel/carousel) | Profile listing needs a session — see below |
| X / Twitter | ✅ Confirmed | Both `x.com` and legacy `twitter.com` |
| Facebook | ✅ Confirmed | Reels |
| Reddit | ✅ Confirmed | Including separate video+audio DASH streams |
| Vimeo | ✅ Confirmed | Auto-retries via embed URL when watch page requires login |
| Dailymotion | ✅ Confirmed | Some clips have no audio at the source — not a bug |
| Bluesky | ✅ Confirmed | |
| Streamable | ✅ Confirmed | |
| Rutube | ✅ Confirmed | |
| SoundCloud | ✅ Confirmed (single track) | Profile/browse pages rejected with a clear error |
| Snapchat | ✅ Confirmed | |
| Twitch | ✅ Confirmed | VODs, including 50+ minute recordings |
| Pinterest | ✅ Confirmed (pins + boards) | Public API, no auth needed — see below |
| Loom, Newgrounds, Tumblr | ⚠️ Wired, untested | Newgrounds correctly blocks age-restricted content |
| Instagram (profile listing) | ⚠️ Requires your own session | See below |

## Install

System tools (install first):

```bash
# Node.js 20+, PostgreSQL 14+, then:
pip install -U yt-dlp
# ffmpeg: sudo apt-get install ffmpeg (Linux) or https://ffmpeg.org/download.html
```

Verify each:

```bash
node --version
psql --version
yt-dlp --version
ffmpeg -version && ffprobe -version
```

Project setup:

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL at minimum
npm run migrate
npm run diagnostics   # checks all of the above are reachable
npm run dev           # starts on http://localhost:4000
```

npm packages: `express`, `pg`, `zod`, `helmet`, `cors`, `express-rate-limit`, `pino`/`pino-http`,
`uuid`, `dotenv`, plus fallback providers `@tobyg74/tiktok-api-dl` and `btch-downloader`.
`npm ls --depth=0` lists exact installed versions; `npm run typecheck` and `npm test` verify the
project builds and passes its test suite.

## Usage

See [docs/API.md](docs/API.md) for every endpoint with full request/response examples, and a
step-by-step "fetch → pick format → download → poll → stream" walkthrough for building a frontend.

```
POST   /api/v1/fetch            resolve metadata + formats (rangeStart/rangeEnd for Pinterest boards)
POST   /api/v1/fetch/audio      resolve audio/MP3 options
POST   /api/v1/download         start a download job (formatId defaults to "best")
GET    /api/v1/downloads/:id    stream the resolved media once ready
DELETE /api/v1/downloads/:id    cancel + clean up temp files
GET    /api/v1/jobs/:id         poll job status/progress
DELETE /api/v1/jobs/:id         cancel a job
GET    /api/v1/platforms        list supported platforms + domains
GET    /health / /health/ready  liveness / readiness (DB, yt-dlp, ffmpeg)
```

## Instagram profile listing (optional)

Single posts/reels/carousels work with no setup. Listing everything a profile has posted
requires your own logged-in session (Instagram blocks this anonymously, even for public
accounts):

```bash
pip install instaloader
instaloader --login <your_username>
```

Then in `.env`:

```
PYTHON_PATH=python
INSTAGRAM_INSTALOADER_SESSION_PATH=/path/to/session/file
INSTAGRAM_INSTALOADER_SESSION_USERNAME=<your_username>
```

The backend never requests or stores Instagram credentials itself — only a session you created
yourself. Without this set, a profile URL returns a clear `LOGIN_REQUIRED` error.

## Production

```bash
npm ci && npm run build && npm run migrate && npm start
```

Full VPS deployment guide (Nginx, PM2, SSL, firewall): [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Troubleshooting

- `npm run diagnostics` — Node/PostgreSQL/yt-dlp/ffmpeg/Instaloader status and versions.
- `GET /health/ready` — same checks over HTTP.
- Update yt-dlp regularly: `pip install -U yt-dlp` (platforms change extraction often).
- Extractor errors return a normalized code (`EXTRACTOR_FAILED`, `LOGIN_REQUIRED`, etc.); raw
  yt-dlp stderr is only in the server logs.
