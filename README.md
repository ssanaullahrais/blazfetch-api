# Blazfetch Backend

A server that takes a link from a social platform (YouTube, TikTok, Instagram, X/Twitter,
Facebook, Reddit, Vimeo, Dailymotion, Bluesky, Streamable, Rutube, SoundCloud, Snapchat, Twitch,
or Pinterest) and lets you download the video, audio, or photos in it. It doesn't keep a copy of
anyone's media on its own server. It fetches the file, checks that it actually works, sends it
straight through to whoever asked, and deletes any temporary files afterward.

## Platform status

| Platform | Status | Notes |
|---|---|---|
| YouTube | ✅ Confirmed | Video, playlists, best-quality auto-select |
| TikTok | ✅ Confirmed | yt-dlp primary, `@tobyg74/tiktok-api-dl` fallback |
| Instagram | ✅ Confirmed | Posts, reels, carousels |
| X / Twitter | ✅ Confirmed | Both `x.com` and legacy `twitter.com` |
| Facebook | ✅ Confirmed | Reels |
| Reddit | ✅ Confirmed | Including separate video+audio DASH streams |
| Vimeo | ✅ Confirmed | Auto-retries via embed URL when watch page requires login. DRM-protected videos return a clear error |
| Dailymotion | ✅ Confirmed | Some clips have no audio at the source — not a bug |
| Bluesky | ✅ Confirmed | |
| Streamable | ✅ Confirmed | |
| Rutube | ✅ Confirmed | |
| SoundCloud | ✅ Confirmed (single track) | Profile/browse pages rejected with a clear error. DRM-protected (Go+) tracks can't be downloaded |
| Snapchat | ✅ Confirmed | |
| Twitch | ✅ Confirmed | VODs, including 50+ minute recordings |
| Pinterest | ✅ Confirmed (pins + boards) | Public API, no auth needed — see below |
| Loom | ✅ Confirmed | Video and audio, including HLS streams |
| Newgrounds | ✅ Confirmed | Public movies with a video; ones with no video return a clear `MEDIA_NOT_FOUND` |
| Tumblr | ⚠️ Wired, untested | |


## Install

**1. System tools** (install first; Node.js 20+ is also required):

```bash
pip install -U yt-dlp
# ffmpeg: sudo apt-get install ffmpeg (Linux) or https://ffmpeg.org/download.html
```

Verify each:

```bash
node --version
yt-dlp --version
ffmpeg -version && ffprobe -version
```

**2. Project setup** (one command picks and configures your database):

```bash
npm install
npm run setup         # choose SQLite / PostgreSQL / MySQL / MongoDB; writes .env and creates the tables
npm run diagnostics   # checks the database, yt-dlp and ffmpeg are all reachable
npm run dev           # starts on http://localhost:4000
```

### Choosing a database

`npm run setup` asks which database to use. **SQLite is the default and needs nothing installed**:
just press Enter and you're running. Pick another if you already have a server:

| Database | Status | You need | Connection URL example |
|---|---|---|---|
| SQLite (default) | ✅ Confirmed | nothing | none (the file is created automatically) |
| PostgreSQL 14+ | ✅ Confirmed | an empty database created first | `postgres://user:password@localhost:5432/blazfetch` |
| MySQL 8+ / MariaDB | ✅ Confirmed | an empty database created first | `mysql://user:password@localhost:3306/blazfetch` |
| MongoDB 6+ | ✅ Confirmed | a running server | `mongodb://localhost:27017/blazfetch` |

Confirmed = tested end to end from a fresh clone: setup, server start, fetch, download, and rows
written to the jobs, cache and stats storage.

Setup creates the tables, not the database itself. For PostgreSQL run `createdb -E UTF8 blazfetch` first,
for MySQL `CREATE DATABASE blazfetch CHARACTER SET utf8mb4;`. All four store the same data (metadata cache, jobs, stats,
never the downloaded media) and the app behaves identically on each.

Prefer to configure by hand? Copy `.env.example` to `.env`, set `DATABASE_DRIVER` (`sqlite`,
`postgres`, `mysql` or `mongodb`) and `DATABASE_URL`, then run `npm run migrate`. Setup can also run
non-interactively: `npm run setup -- --driver=postgres --url=postgres://user:pass@host:5432/blazfetch`.

`npm run typecheck` and `npm test` verify the project builds and passes its test suite.

## Usage

See [docs/API.md](docs/API.md) for every endpoint with full request/response examples, and a
step-by-step "fetch → pick format → download → poll → stream" walkthrough for building a frontend.

```
POST   /api/v1/fetch            resolve metadata + formats (rangeStart/rangeEnd for Pinterest boards)
POST   /api/v1/fetch/audio      resolve audio/MP3 options
POST   /api/v1/download         start a download job (formatId defaults to "best")
GET    /api/v1/stream           direct stream: bytes start immediately, no job, no temp file
GET    /api/v1/downloads/:id    stream the resolved media once ready
DELETE /api/v1/downloads/:id    cancel + clean up temp files
GET    /api/v1/jobs/:id         poll job status/progress
DELETE /api/v1/jobs/:id         cancel a job
GET    /api/v1/platforms        list supported platforms + domains
GET    /health / /health/ready  liveness / readiness (DB, yt-dlp, ffmpeg)
```

## Production

```bash
npm ci && npm run build && npm run migrate && npm start
```

Full VPS deployment guide (Nginx, PM2, SSL, firewall): [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Troubleshooting

- `npm run diagnostics` — database/yt-dlp/ffmpeg status and versions.
- `GET /health/ready` — same checks over HTTP.
- Update yt-dlp regularly: `pip install -U yt-dlp` (platforms change extraction often).
- Extractor errors return a normalized code (`EXTRACTOR_FAILED`, `LOGIN_REQUIRED`, etc.); raw
  yt-dlp stderr is only in the server logs.
