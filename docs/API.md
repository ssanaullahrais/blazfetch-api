# Blazfetch Backend API

Base URL: `{APP_URL}/api/v1` (e.g. `http://localhost:4000/api/v1`). All request/response bodies
are JSON unless noted. An OpenAPI 3.0 definition is available at [openapi.yaml](openapi.yaml).

## Platform status

Verified with real downloads against live URLs, not just metadata calls. "Confirmed" means a
real video/audio file was downloaded and ffprobe-validated (correct streams, valid duration).

| Platform | Status | Notes |
|---|---|---|
| YouTube | ✅ Confirmed | Video, playlists (flat listing), best-quality auto-select |
| TikTok | ✅ Confirmed | yt-dlp primary, `@tobyg74/tiktok-api-dl` fallback |
| Instagram | ✅ Confirmed | Posts, reels, carousels |
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
| Loom | ✅ Confirmed | Video and audio, including HLS streams |
| Newgrounds, Tumblr | ⚠️ Wired, untested | Newgrounds returned 403 (bot protection) from the test machine |


Authentication is not yet implemented in this scaffold — every endpoint currently runs as a
guest, tracked by a `blazfetch_guest_id` cookie the server sets automatically. `req.userId` is
wired through the whole stack (jobs, stats, rate limiting) so adding real auth later only means
populating it from a session/JWT middleware.

## Error format

Every error response has this shape:

```json
{
  "success": false,
  "error": { "code": "UNSUPPORTED_PLATFORM", "message": "This platform is currently not supported." },
  "requestId": "a1b2c3..."
}
```

| Code | HTTP status | Meaning |
|---|---|---|
| `UNSUPPORTED_PLATFORM` | 422 | Domain isn't in the platform whitelist |
| `INVALID_URL` | 400 | Malformed URL or disallowed protocol/host |
| `MEDIA_NOT_FOUND` | 404 | Extractor found nothing at the URL |
| `PRIVATE_MEDIA` | 403 | Source reports the media as private |
| `LOGIN_REQUIRED` | 401 | Source requires authentication to view |
| `AGE_RESTRICTED` | 403 | Source reports age restriction |
| `GEO_RESTRICTED` | 403 | Source reports regional restriction |
| `EXTRACTOR_FAILED` | 502 | yt-dlp/fallback provider failed for another reason |
| `PLATFORM_RATE_LIMITED` | 429 | Source platform is rate-limiting us |
| `DOWNLOAD_FAILED` | 502 | Download/merge/transcode/proxy step failed |
| `FORMAT_UNAVAILABLE` | 404 | Requested formatId no longer resolves |
| `PROCESS_TIMEOUT` | 504 | yt-dlp/ffmpeg/ffprobe exceeded its timeout |
| `FILE_TOO_LARGE` | 413 | Exceeds `MAX_DOWNLOAD_SIZE_BYTES` |
| `SERVER_BUSY` | 503 | Concurrency limit reached |
| `VALIDATION_ERROR` | 400 | Request body failed schema validation |
| `JOB_NOT_FOUND` | 404 | Job id doesn't exist or isn't ready yet |

Raw yt-dlp stderr is never returned to the client — it's logged server-side against the
request id for debugging.

---

## `POST /api/v1/fetch`

Resolve metadata, thumbnails, and video/image formats for a supported URL.

**Auth:** guest cookie (automatic)
**Rate limit:** `RATE_LIMIT_MAX_GUEST` / `RATE_LIMIT_MAX_USER` per `RATE_LIMIT_WINDOW_MS`

### Request body

```json
{ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "forceRefresh": false }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Any URL from a supported platform domain |
| `forceRefresh` | boolean | no | Bypass the metadata cache and re-extract |
| `rangeStart` | integer | no | 1-based, inclusive. Collection URLs only (Pinterest boards); ignored otherwise |
| `rangeEnd` | integer | no | 1-based, inclusive. Collection URLs only (Pinterest boards); ignored otherwise |

### Response `200`

```json
{
  "success": true,
  "platform": "youtube",
  "mediaType": "video",
  "mediaId": "dQw4w9WgXcQ",
  "canonicalUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "...",
  "author": { "name": "...", "url": "..." },
  "thumbnail": "https://...",
  "durationSeconds": 212,
  "uploadDate": "20091025",
  "formats": [
    { "formatId": "18", "ext": "mp4", "kind": "video", "quality": "360p", "width": 640, "height": 360, "compatible": true, "requiresMerge": false },
    { "formatId": "137", "ext": "mp4", "kind": "video_only", "quality": "1080p", "width": 1920, "height": 1080, "compatible": true, "requiresMerge": true }
  ],
  "audioFormats": [
    { "formatId": "140", "ext": "m4a", "bitrate": 128, "codec": "mp4a.40.2", "isConverted": false }
  ],
  "metadata": { "isLive": false },
  "extractor": "yt-dlp"
}
```

`formats[].compatible: true` marks H.264-video (and, for combined formats, AAC-audio) options —
the safe default for "give me a normal MP4" without a transcode step. `requiresMerge: true` means
the format is video-only and will be paired with the best AAC audio automatically at download
time.

### Playlist example (YouTube)

`POST { "url": "https://www.youtube.com/playlist?list=PL..." }` →

```json
{
  "success": true,
  "platform": "youtube",
  "mediaType": "playlist",
  "isPlaylist": true,
  "itemCount": 42,
  "playlist": {
    "title": "...",
    "channel": "...",
    "itemCount": 42,
    "items": [
      { "videoId": "abc123", "title": "...", "thumbnail": "https://...", "durationSeconds": 180, "url": "https://www.youtube.com/watch?v=abc123" }
    ]
  },
  "formats": [],
  "audioFormats": [],
  "metadata": {},
  "extractor": "yt-dlp"
}
```

Fetch full formats for one entry by calling `POST /fetch` again with that entry's `url`.

### Pinterest board example

`POST { "url": "https://www.pinterest.com/<username>/<board-slug>/" }` → every pin in the board
as a carousel of mixed image/video items, resolved via Pinterest's own public `PinResource`/
`BoardResource` API (no authentication required):

```json
{
  "success": true,
  "platform": "pinterest",
  "mediaType": "carousel",
  "isCarousel": true,
  "itemCount": 56,
  "title": "Board name",
  "items": [
    { "id": "581316264442190336", "type": "video", "thumbnail": "https://...", "durationSeconds": 58.7,
      "formats": [{ "formatId": "board-581316264442190336-mp4", "ext": "mp4", "kind": "video", "width": 720, "height": 1280, "compatible": true }] },
    { "id": "581316264448862762", "type": "image", "thumbnail": "https://...", "source": "https://i.pinimg.com/originals/..." }
  ],
  "formats": [],
  "audioFormats": [],
  "metadata": { "totalPinCount": 59, "rangeStart": 1, "rangeEnd": 56, "truncated": false, "maxItemsPerRequest": 200 },
  "extractor": "pinterest-board-api",
  "fallbackUsed": "pinterest-board-api"
}
```

Image items are downloaded directly from `items[].source` (already the highest-resolution
`orig` variant Pinterest has for that pin — verified against Pinterest's own metadata, not a
grid thumbnail). Video items are downloaded via `POST /download` using their `formats[].formatId`.

**Ranged requests** — for a large board, request a slice instead of the whole thing:

```json
{ "url": "https://www.pinterest.com/<username>/<board-slug>/", "rangeStart": 50, "rangeEnd": 100 }
```

`rangeStart`/`rangeEnd` are 1-based and inclusive. Pinterest's pagination is cursor-based, not
offset-based, so requesting items 950-1000 of a huge board takes as long as requesting 1-1000 —
pages are still walked sequentially from the start. Ranged requests always bypass the metadata
cache. A single individual pin URL (`/pin/<id>`) ignores range params entirely.

### Instagram carousel example

```json
{
  "success": true,
  "platform": "instagram",
  "mediaType": "carousel",
  "isCarousel": true,
  "itemCount": 3,
  "items": [
    { "id": "0", "type": "image", "thumbnail": "https://...", "source": "https://..." },
    { "id": "1", "type": "video", "thumbnail": "https://...", "durationSeconds": 12, "formats": [ { "formatId": "1", "ext": "mp4", "kind": "video", "url": "https://..." } ] }
  ],
  "formats": [],
  "audioFormats": [],
  "extractor": "yt-dlp"
}
```

### Failed request examples

```json
{
  "success": false,
  "error": { "code": "UNSUPPORTED_PLATFORM", "message": "This platform is currently not supported." },
  "requestId": "b3f1..."
}
```

```json
{
  "success": false,
  "error": { "code": "MEDIA_NOT_FOUND", "message": "Media could not be found at the given URL." },
  "requestId": "c4a2..."
}
```

```json
{
  "success": false,
  "error": { "code": "AGE_RESTRICTED", "message": "This media is age-restricted." },
  "requestId": "d5b3..."
}
```

---

## `POST /api/v1/fetch/audio`

Same input shape as `/fetch`, scoped to audio/MP3 options only.

### Response `200`

```json
{
  "success": true,
  "platform": "soundcloud",
  "mediaId": "...",
  "canonicalUrl": "https://soundcloud.com/...",
  "title": "...",
  "durationSeconds": 245,
  "audioFormats": [
    { "formatId": "http_mp3_128", "ext": "mp3", "bitrate": 128, "isConverted": false }
  ],
  "requiresConversion": false
}
```

If the source has no standalone audio track (e.g. a TikTok fallback that only returned a full
MP4), `requiresConversion: true` and `audioFormats` includes a synthetic `mp3-from-<formatId>`
entry — requesting a download with that `formatId` triggers ffmpeg extraction server-side.

---

## `POST /api/v1/download`

Starts a download job and returns immediately with a job handle; the actual resolve/merge/
transcode work continues in the background. Poll `GET /jobs/:id` or open
`GET /downloads/:id` once the job is `ready`/`completed`.

**Rate limit:** `RATE_LIMIT_MAX_DOWNLOAD` per `RATE_LIMIT_WINDOW_MS`

### Request body

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "formatId": "137",
  "kind": "video",
  "quality": "1080p"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Any URL from a supported platform domain |
| `formatId` | string | no (default `"best"`) | A `formatId` previously returned by `/fetch` or `/fetch/audio` — never a raw yt-dlp format string or shell argument. Omit it (or pass `"best"`) to skip picking a format entirely: the backend automatically selects the highest resolution for video, or the highest-bitrate audio (converting to MP3 via ffmpeg if the source has no standalone audio track) |
| `kind` | `"video"` \| `"audio"` | yes | |
| `quality` | string | no | Informational only; doesn't affect selection |

### Response `202`

```json
{
  "success": true,
  "job": {
    "id": "a3b6...",
    "status": "preparing",
    "platform": "youtube",
    "canonicalUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "requestedFormat": { "formatId": "137", "kind": "video" },
    "progress": 0,
    "downloadedBytes": 0,
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
}
```

---

## `GET /api/v1/downloads/:id`

Streams the resolved media once the job is `ready` (proxying from the source URL) or `completed`
(a local temp file produced by yt-dlp/ffmpeg). Responds with the file body directly —
`Content-Type`, `Content-Length` (when known), and `Content-Disposition: attachment`.

If the job isn't ready yet, responds `404 JOB_NOT_FOUND` with a message pointing at `GET /jobs/:id`
for polling.

## `DELETE /api/v1/downloads/:id`

Cancels the job (terminating any in-flight yt-dlp/ffmpeg process) and removes its temp directory.

---

## `GET /api/v1/jobs/:id`

```json
{
  "success": true,
  "job": {
    "id": "a3b6...",
    "status": "streaming",
    "progress": 64,
    "downloadedBytes": 67108864,
    "totalBytes": 104857600,
    "platform": "youtube",
    "filename": "dQw4w9WgXcQ.mp4",
    "mimeType": "video/mp4",
    "updatedAt": "2026-01-01T00:00:05.000Z"
  }
}
```

`status` is one of: `queued`, `preparing`, `ready`, `streaming`, `completed`, `failed`,
`cancelled`, `expired`. Poll this endpoint (e.g. every 1-2s) to drive a progress bar; once
`status` is `ready` or `completed`, call `GET /downloads/:id` to get the actual file.

Failed job example:

```json
{
  "success": true,
  "job": {
    "id": "a3b6...",
    "status": "failed",
    "progress": 34,
    "platform": "vimeo",
    "errorCode": "LOGIN_REQUIRED",
    "errorMessage": "The web client only works when logged-in.",
    "updatedAt": "2026-01-01T00:00:07.000Z"
  }
}
```

Unknown/expired job id:

```json
{
  "success": false,
  "error": { "code": "JOB_NOT_FOUND", "message": "Job a3b6... was not found." },
  "requestId": "e6c4..."
}
```

## `DELETE /api/v1/jobs/:id`

Cancels a queued or in-progress job.

```json
{ "success": true, "job": { "id": "a3b6...", "status": "cancelled", "...": "..." } }
```

---

## `GET /api/v1/platforms`

Returns all 18 configured platforms (see "Platform status" above for which are verified working).

```json
{
  "success": true,
  "platforms": [
    { "id": "youtube", "label": "YouTube", "domains": ["youtube.com", "youtu.be", "youtube-nocookie.com"] },
    { "id": "tiktok", "label": "TikTok", "domains": ["tiktok.com"] },
    { "id": "instagram", "label": "Instagram", "domains": ["instagram.com", "instagr.am"] },
    { "id": "twitter", "label": "X / Twitter", "domains": ["x.com", "twitter.com", "t.co"] },
    { "id": "facebook", "label": "Facebook", "domains": ["facebook.com", "fb.watch", "fb.me"] },
    { "id": "vimeo", "label": "Vimeo", "domains": ["vimeo.com"] },
    { "id": "reddit", "label": "Reddit", "domains": ["reddit.com", "redd.it"] },
    { "id": "soundcloud", "label": "SoundCloud", "domains": ["soundcloud.com", "snd.sc"] },
    { "id": "pinterest", "label": "Pinterest", "domains": ["pinterest.com", "pin.it", "..."] },
    { "id": "snapchat", "label": "Snapchat", "domains": ["snapchat.com"] },
    { "id": "dailymotion", "label": "Dailymotion", "domains": ["dailymotion.com", "dai.ly"] },
    { "id": "bluesky", "label": "Bluesky", "domains": ["bsky.app"] },
    { "id": "loom", "label": "Loom", "domains": ["loom.com"] },
    { "id": "newgrounds", "label": "Newgrounds", "domains": ["newgrounds.com"] },
    { "id": "rutube", "label": "Rutube", "domains": ["rutube.ru"] },
    { "id": "streamable", "label": "Streamable", "domains": ["streamable.com"] },
    { "id": "twitch", "label": "Twitch", "domains": ["twitch.tv"] },
    { "id": "tumblr", "label": "Tumblr", "domains": ["tumblr.com"] }
  ]
}
```

---

## `GET /health`

```json
{ "success": true, "status": "ok" }
```

## `GET /health/ready`

```json
{
  "success": true,
  "status": "ready",
  "checks": { "database": true, "databaseDriver": "sqlite", "ytdlp": true, "ytdlpVersion": "2024.12.13", "ffmpeg": true, "ffmpegVersion": "ffmpeg version 6.1.1" }
}
```

Returns `503` with `success: false` if any dependency check fails — suitable as a load balancer
or orchestrator readiness probe:

```json
{
  "success": false,
  "status": "not_ready",
  "checks": {
    "database": true,
    "databaseDriver": "sqlite",
    "ytdlp": true,
    "ytdlpVersion": "2026.08.19",
    "ffmpeg": false,
    "ffmpegVersion": null
  }
}
```

---

## Quick reference for frontend integration

Typical flow for "user pastes a URL, picks a quality, downloads":

1. `POST /fetch` with the URL → get `formats[]`/`audioFormats[]` (or `items[]` for a carousel/
   playlist/board — recurse into each item's own `url` if you need per-item formats).
2. Let the user pick a `formatId`, or skip this and just use `"best"`.
3. `POST /download` with `{ url, formatId, kind }` → get a `job.id` back immediately (`202`).
4. Poll `GET /jobs/:id` every 1-2s until `status` is `ready` or `completed` (or `failed` —
   show `errorCode`/`errorMessage`).
5. Navigate to (or `fetch()`) `GET /downloads/:id` to get the actual file — the browser can
   treat this as a normal download link since it sets `Content-Disposition: attachment`.

For a live progress bar while downloading, `job.progress` (0-100) and `job.downloadedBytes`/
`totalBytes` from the `/jobs/:id` poll response are the numbers to drive it with.
