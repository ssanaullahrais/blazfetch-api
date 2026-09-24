<div align="center">

# BlazFetch Backend

**One API to fetch and download media from 18 social platforms.**<br/>
Paste a link, get every quality option, download it. Nothing is stored except the metadata.

![Node](https://img.shields.io/badge/Node.js-20+-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![Databases](https://img.shields.io/badge/DB-SQLite%20%7C%20PostgreSQL%20%7C%20MySQL%20%7C%20MongoDB-4169E1)
![Platforms](https://img.shields.io/badge/platforms-17%20confirmed-2EA44F)
![Tests](https://img.shields.io/badge/tests-137%20passing-2EA44F)

[Frontend repository](https://github.com/ssanaullahrais/blazfetch-social-downloader-frontend) ·
[API reference](docs/API.md) ·
[VPS deployment](docs/REQUIREMENTS.md) ·
[OpenAPI](docs/openapi.yaml)

</div>

---

> [!TIP]
> **Want the web app?** The ready-made frontend for this API is
> **[ssanaullahrais/blazfetch-social-downloader-frontend](https://github.com/ssanaullahrais/blazfetch-social-downloader-frontend)**:
> start this backend, then run the frontend on top of it.

It takes a link from YouTube, TikTok, Instagram, X/Twitter, Facebook, Reddit, Vimeo, Dailymotion, Bluesky,
Streamable, Rutube, SoundCloud, Snapchat, Twitch, Pinterest, Loom, Newgrounds or Tumblr and lets you download
the video, audio or photos in it. It doesn't keep a copy of anyone's media: it fetches the file, checks that it
actually works, sends it straight through to whoever asked, and deletes any temporary files afterward. (It does
remember each link's details, such as title and formats, so repeat requests are instant. See
[Stored media](#stored-media).)

## Highlights

- **One API for 17 confirmed platforms** (plus Tumblr, wired but not yet verified): title, thumbnail and every quality option, then download.
- **Three ways to download** with a single request: direct stream (starts immediately), prepare (a guaranteed
  H.264/AAC file), or `auto` (stream, and fall back to prepare if the source can't be streamed).
- **Everything fetched is remembered forever** (metadata only), with stable page paths like `/youtube/Cwkej79U3ek`,
  a weekly check that notices deleted videos, and usage statistics.
- **Works when a platform blocks it.** If YouTube blocks the server's IP, a fallback provider answers instead.
- **Your choice of database:** SQLite (default, nothing to install), PostgreSQL, MySQL/MariaDB or MongoDB.
- **Clean by design:** no media is kept on disk, temporary files are always removed, and cancelling a download
  stops every process it started.

## Quick start

Needs Node.js 20+, yt-dlp and ffmpeg (see [Install](#install)).

```bash
npm install
npm run setup        # pick a database (press Enter for SQLite); creates .env and the tables
npm run dev          # http://localhost:4000
```

```bash
# 1. look up a link (metadata, thumbnail, formats)
curl -X POST http://localhost:4000/api/v1/fetch   -H "content-type: application/json"   -d '{"url":"https://www.tiktok.com/@scout2015/video/6718335390845095173"}'

# 2. download it in one request (best quality; falls back automatically if it can't be streamed)
curl -G http://localhost:4000/api/v1/stream   --data-urlencode "url=https://www.tiktok.com/@scout2015/video/6718335390845095173"   -d mode=auto -o video.mp4
```

Real responses for every platform are in [docs/API.md](docs/API.md#responses-by-platform).

## Platform status

Each platform was tested with real downloads. Its actual API response is in [docs/API.md](docs/API.md#responses-by-platform).

| Platform | Status | Notes |
|---|---|---|
| YouTube | ✅ Confirmed | Video, playlists, best-quality auto-select. If YouTube temporarily blocks the server's IP ("confirm you're not a bot"), a fallback provider serves the request automatically |
| TikTok | ✅ Confirmed | yt-dlp primary, `@tobyg74/tiktok-api-dl` fallback |
| Instagram | ✅ Confirmed | Posts and reels (profile listing is not supported) |
| X / Twitter | ✅ Confirmed | Both `x.com` and legacy `twitter.com` |
| Facebook | ✅ Confirmed | Reels and public videos. Posts that need a login return an error |
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

See [docs/API.md](docs/API.md) for every endpoint with full request/response examples (including a real
response for each platform) and a frontend walkthrough. The endpoints:

```
POST   /api/v1/fetch                     resolve metadata + formats (rangeStart/rangeEnd for Pinterest boards)
POST   /api/v1/fetch/audio               resolve audio options
GET    /api/v1/media/<platform>/<id>     stored media by stable path (e.g. /youtube/Cwkej79U3ek)
GET    /api/v1/stream                    one-request download: ?mode=stream (default) | prepare | auto
POST   /api/v1/download                  start a download job (formatId defaults to "best")
GET    /api/v1/jobs/:id                  poll job status/progress
GET    /api/v1/downloads/:id             stream the file once the job is ready
DELETE /api/v1/downloads/:id             cancel + clean up temp files
DELETE /api/v1/jobs/:id                  cancel a job
GET    /api/v1/platforms                 list supported platforms + domains
GET    /health, /health/ready            liveness / readiness (DB, yt-dlp, ffmpeg)
```

### Which download method?

| You want | Use |
|---|---|
| Fastest start, nothing on the server's disk | `GET /stream?mode=stream` (default) |
| It to work for every source in one request (**recommended**) | `GET /stream?mode=auto` |
| A guaranteed H.264/AAC file | `GET /stream?mode=prepare` |
| Server-side progress for a long file | `POST /download`, then poll `GET /jobs/:id` |

### Building a frontend

The official one already exists: [blazfetch-social-downloader-frontend](https://github.com/ssanaullahrais/blazfetch-social-downloader-frontend). To build your own:

- Send `credentials: 'include'` on every request: the server identifies visitors with a guest cookie
  (rate limits and concurrency use it).
- Put your frontend's exact origin in `CORS_ALLOWED_ORIGINS` (`*` does not work with cookies).
- Use `stored.path` from a fetch response for your own page URLs, and call `GET /media/<platform>/<id>` to render them.

## Stored media

Everything fetched is kept in the database forever (metadata only, never the media files), so repeat
requests are answered in milliseconds and every item gets a stable path such as
`/youtube/Cwkej79U3ek` (playlists: `/youtube/Cwkej79U3ek/playlist/RDCwkej79U3ek`). Each item is
re-checked every 7 days, so deleted or private videos are noticed and answer a clear
`410 MEDIA_UNAVAILABLE` instead of stale data, and usage statistics are stored per item and per event.
See [docs/API.md](docs/API.md#stored-media-and-stable-paths).

## Configuration

`npm run setup` writes the database settings; everything else has a working default. The settings you
are most likely to change (all in `.env`, full list with comments in [.env.example](.env.example)):

| Setting | Default | What it does |
|---|---|---|
| `DATABASE_DRIVER`, `DATABASE_URL` | `sqlite` | Which database, and where (`npm run setup` sets these) |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | Your frontend's origin(s), comma separated |
| `DEFAULT_DOWNLOAD_MODE` | `stream` | Default for `GET /stream` when a request has no `?mode=` |
| `STREAM_MODE_ENABLED` | `true` | Turn `GET /stream` off entirely |
| `REVALIDATE_AFTER_SECONDS` | `604800` (7 days) | How often each stored item is re-checked |
| `YOUTUBE_FALLBACK_ENABLED` | `true` | Use a fallback provider when YouTube blocks the server |
| `MAX_CONCURRENT_DOWNLOADS_GLOBAL` / `_PER_GUEST` | `10` / `1` | Concurrency limits |
| `RATE_LIMIT_MAX_GUEST` / `RATE_LIMIT_MAX_DOWNLOAD` | `30` / `10` per minute | Rate limits |
| `MAX_DOWNLOAD_SIZE_BYTES`, `TEMP_DIR` | 2 GB, `./tmp` | Size cap and temporary folder |

## Documentation

| Document | What's in it |
|---|---|
| [docs/API.md](docs/API.md) | Every endpoint, error codes, real responses per platform, stored media, modes |
| [docs/examples/](docs/examples/) | Each platform's response as a JSON file |
| [docs/openapi.yaml](docs/openapi.yaml) | OpenAPI 3.0 definition (for generating a typed client) |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Step-by-step VPS deployment: Nginx, HTTPS, PM2, firewall, backups |

## Production

```bash
npm ci && npm run build && npm run migrate && npm start
```

`npm run migrate` upgrades the database in place and does nothing when it is already up to date, so run it on
every deploy. Full VPS deployment guide (Nginx, PM2, SSL, firewall, backups): [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

Run **one** app instance per database: the weekly re-check job and the concurrency limits live inside the
process (several instances would just repeat some checks).

## Testing

137 tests (unit and integration) cover the API, stream modes, the media store and every database driver path.

```bash
npm test             # unit + integration tests (no network needed)
npm run typecheck
```

## Troubleshooting

- `npm run diagnostics` shows database/yt-dlp/ffmpeg status and versions. `GET /health/ready` does the same over HTTP.
- Update yt-dlp regularly (`pip install -U yt-dlp`): platforms change how they serve video.
- **YouTube says "confirm you're not a bot":** YouTube temporarily blocked the server's IP after many requests.
  A fallback provider serves requests automatically (check `fallbackUsed` in responses) and yt-dlp is
  retried after a short cooldown. The block usually clears in minutes to hours.
- **Newgrounds, Facebook or Rutube fail with a `403`-style error:** the site blocks some server IPs. Try again
  later or from another network.
- **`LOGIN_REQUIRED`, `PRIVATE_MEDIA`, `AGE_RESTRICTED`, `MEDIA_UNAVAILABLE`:** the media itself needs a login, is
  private or age-gated, or was deleted. Nothing to fix on the server.
- Extractor errors return a normalized code (`EXTRACTOR_FAILED`, ...); raw yt-dlp output is only in the server logs.
- A download that fails with `mode=stream` for one source (Loom is one) works with `mode=auto` or `mode=prepare`.

---

<div align="center">
Frontend: <a href="https://github.com/ssanaullahrais/blazfetch-social-downloader-frontend">blazfetch-social-downloader-frontend</a>
</div>
