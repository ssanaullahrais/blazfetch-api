# Blazfetch Backend API

Base URL: `{APP_URL}/api/v1` (e.g. `http://localhost:4000/api/v1`). All request/response bodies
are JSON unless noted. An OpenAPI 3.0 definition is available at [openapi.yaml](openapi.yaml).

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

### Failed request example

```json
{
  "success": false,
  "error": { "code": "UNSUPPORTED_PLATFORM", "message": "This platform is currently not supported." },
  "requestId": "b3f1..."
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

`formatId` must be a value previously returned by `/fetch` or `/fetch/audio` — never a raw yt-dlp
format string or shell argument.

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
`cancelled`, `expired`.

## `DELETE /api/v1/jobs/:id`

Cancels a queued or in-progress job.

---

## `GET /api/v1/platforms`

```json
{
  "success": true,
  "platforms": [
    { "id": "youtube", "label": "YouTube", "domains": ["youtube.com", "youtu.be", "youtube-nocookie.com"] }
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
  "checks": { "database": true, "ytdlp": true, "ytdlpVersion": "2024.12.13", "ffmpeg": true, "ffmpegVersion": "ffmpeg version 6.1.1" }
}
```

Returns `503` with `success: false` if any dependency check fails — suitable as a load balancer
or orchestrator readiness probe.
