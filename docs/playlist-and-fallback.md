# Playlists and fallback setup

## Configuration

Set in backend `.env`, then restart:

```dotenv
MAX_PLAYLIST_ITEMS=1000
MAX_PLAYLIST_DOWNLOAD_ITEMS=200
PLAYLIST_DOWNLOAD_CONCURRENCY=1

# Optional authorized Cobalt service
COBALT_API_URL=
COBALT_API_KEY=

# Optional YouTube Data API v3 key, for playlist listing only
YOUTUBE_DATA_API_KEY=
```

| Setting | Purpose |
|---|---|
| `MAX_PLAYLIST_ITEMS` | Listing cap. Existing `.env` values do not change automatically |
| `MAX_PLAYLIST_DOWNLOAD_ITEMS` | Separate bulk preparation cap; budget temporary disk for the whole batch |
| `PLAYLIST_DOWNLOAD_CONCURRENCY` | 1–4 workers, also bounded by visitor/global limits |
| `COBALT_API_URL` | Your own or explicitly authorized Cobalt endpoint; no public provider is enabled by default |
| `YOUTUBE_DATA_API_KEY` | Paginated listing fallback when yt-dlp fails; does not download media |

After raising the listing cap, use `POST /api/v1/fetch` with `"forceRefresh": true` to replace cached playlists. `metadata.playlistTruncated` indicates a possible listing limit. The official frontend reveals rows automatically on scroll, but cannot show entries missing from the API response.

No new npm package or database migration is required. Cobalt runs separately. For Node/EJS and media-proxy setup, see the [VPS guide](REQUIREMENTS.md#media-extraction-dependencies-and-optional-recovery).

## Bulk download API

Keep the guest cookie from job creation. If enabled, API-key protection and Turnstile also apply.

```http
POST /api/v1/playlist/download
Content-Type: application/json

{ "url": "https://www.youtube.com/playlist?list=...", "kind": "video", "maxItems": 3 }
```

- Returns HTTP 202 with `{ success, job }`.
- `kind` defaults to `video`; `maxItems` is optional, bounded by both listing and bulk caps.
- Accepts playlist URLs and watch URLs containing a playlist. Prepares best available quality.

| Endpoint | Use |
|---|---|
| `GET /api/v1/playlist/downloads/:id` | Poll `total`, `prepared`, `failed`, `progress`, `outcome` and per-item results |
| `DELETE /api/v1/playlist/downloads/:id` | Cancel unfinished work and release temporary files |

Download each `items[].downloadUrl` separately with the same guest cookie. There is no ZIP response. An item failure does not stop later items; check `outcome: "partial"` and each item's error.

`ready` means prepared, not delivered. Download counters increase after successful delivery. Size, disk, retention and conversion limits still apply. Records persist, but unfinished workers do not resume after a restart.

## Fallback behavior

- Cobalt supports `redirect`/`tunnel` responses only, not picker/carousel or local-processing responses.
- Newgrounds audio pages recover as audio-only; movie pages retain video recovery.
- Endpoint/media addresses must be public; private addresses and endpoint redirects are rejected. Credentials stay server-side.
- Retries transient extractor, timeout, rate-limit and format failures. Private/deleted/age/geo restrictions are preserved; provider failure returns the original error.
- Tumblr also retries transient dedicated-extractor failures with yt-dlp's generic public-page extractor.
- HTTP 429 maps to `PLATFORM_RATE_LIMITED`, timeouts to `PROCESS_TIMEOUT`, and unexplained HTTP 403 to `EXTRACTOR_FAILED`.

Provider support and source access depend on the deployment network. Test completed transfers from your VPS; a successful listing or metadata request is not a successful download.

## Developer checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
npx tsx scripts/platform-smoke.ts --platform=youtube --download
```

| Smoke option | Check |
|---|---|
| `--audio` / `--best` / `--prepare` | Audio / best quality / prepared delivery |
| `--playlist-limit=1000` | Full listing instead of the three-entry test sample |
| `--download --audio --bulk` | Prepare and deliver one playlist item |
| `--platform=twitch --download --url-twitch=https://clips.twitch.tv/FaintLightGullWholeWheat` | Short Twitch clip instead of a long VOD |

The smoke script uses an isolated temporary database/media directory and ffprobe validation. It does not load deployment `.env`; supply `API_AUTH_ENABLED` and `API_AUTH_KEY` explicitly for authenticated checks. Transfers have a 180-second/80-MiB safety limit.

### Last sample check: September 30, 2026

Completed and ffprobe-checked samples: YouTube video/audio, TikTok, Instagram, X, Facebook, Vimeo, Reddit, SoundCloud, Pinterest, Snapchat, Dailymotion, Bluesky, Loom, Rutube, Streamable, Twitch clip and Tumblr stream/prepare.

The Twitch VOD sample completed at 160p: 89,272,690 bytes, H.264/AAC, 3,008.10 seconds. The transfer took 274 seconds, beyond the default smoke-script budget.

Newgrounds returned HTTP 403 on the test network. A configured Cobalt provider and VPS behavior remain unverified. The YouTube test playlist returned 210 entries; all-item delivery was not tested.
