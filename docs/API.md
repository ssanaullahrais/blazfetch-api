<div align="center">

# BlazFetch API Reference

**Every endpoint, error code and a real response for each platform.**

![Version](https://img.shields.io/badge/API-v1-2EA44F)
![Format](https://img.shields.io/badge/format-JSON-4169E1)
![OpenAPI](https://img.shields.io/badge/OpenAPI-3.0-6BA539?logo=openapiinitiative&logoColor=white)

[Back to README](../README.md) ·
[OpenAPI file](openapi.yaml) ·
[Example responses](examples/) ·
[Frontend repository](https://github.com/ssanaullahrais/blazfetch-web)

</div>

---

Base URL: `{APP_URL}/api/v1` (e.g. `http://localhost:4000/api/v1`). All request and response bodies are JSON
unless noted. Every example in [Responses by platform](#responses-by-platform) is also saved as a JSON file in
[`examples/`](examples/).

> [!NOTE]
> Authentication is not implemented yet. Every endpoint runs as a guest, tracked by a `blazfetch_guest_id`
> cookie the server sets automatically. `req.userId` is wired through the whole stack (jobs, stats, rate
> limiting), so adding real auth later only means populating it from a session or JWT middleware.

## Contents

| Section | |
|---|---|
| [Endpoints at a glance](#endpoints-at-a-glance) | The whole API on one page, and which download method to use |
| [Platform status](#platform-status) | What was tested and confirmed |
| [Error format](#error-format) | The error envelope and every code |
| [`POST /fetch`](#post-apiv1fetch) | Resolve a link |
| [Responses by platform](#responses-by-platform) | A real response for every platform |
| [`POST /fetch/audio`](#post-apiv1fetchaudio) | Audio options |
| [`POST /download`](#post-apiv1download), [jobs](#get-apiv1jobsid), [downloads](#get-apiv1downloadsid) | Job flow with server-side progress |
| [`GET /stream`](#get-apiv1stream-direct-stream-prepare-or-auto) | One-request download: stream, prepare or auto |
| [YouTube blocks and the fallback](#youtube-blocks-and-the-fallback-provider) | What happens when YouTube blocks the server |
| [Stored media](#stored-media-and-stable-paths) | Stable paths, weekly checks, statistics |
| [`GET /health`](#get-health) | Liveness and readiness |
| [Frontend integration](#quick-reference-for-frontend-integration) | The short version for building a UI |

## Endpoints at a glance

| Endpoint | What it does |
|---|---|
| [`POST /fetch`](#post-apiv1fetch) | Resolve metadata, thumbnails and formats for a link. The result is stored forever, so repeat requests are instant |
| [`POST /fetch/audio`](#post-apiv1fetchaudio) | The same, scoped to audio options |
| [`GET /media/<platform>/<id>`](#get-apiv1mediaplatformid-serve-by-stable-path) | Serve stored media by its stable path (e.g. `/youtube/Cwkej79U3ek`) for pretty page URLs |
| [`GET /stream`](#get-apiv1stream-direct-stream-prepare-or-auto) | Download in one request. `mode=stream` (default), `prepare`, or `auto` (stream, fall back to prepare) |
| [`POST /download`](#post-apiv1download), [`GET /jobs/:id`](#get-apiv1jobsid), [`GET /downloads/:id`](#get-apiv1downloadsid) | Job-based download with server-side progress |
| `DELETE /downloads/:id`, `DELETE /jobs/:id` | Cancel a job and clean up |
| `GET /stats` | Public all-time totals `{ fetches, downloads, online }`. Every successful `POST /fetch` and `GET /media/...` response counts once, including repeat and concurrent requests. Internal lookups, audio format lookups, background refreshes and failed requests are excluded. Downloads count when the API finishes delivering bytes, including prepared files; merely preparing a job does not count. `online` is the number of distinct visitors with a live `/stats/events` connection seen within `ONLINE_VISITOR_WINDOW_SECONDS` (default 60s) — backed by the database, so it is correct across multiple API instances, not just the one a visitor happens to be connected to. Calling this endpoint also counts as presence, so a visitor polling it directly (no live connection) still shows as online. No per-visitor data or browser caching |
| `GET /stats/events` | Server-sent events with the same totals (`fetches`, `downloads`, `online`), pushed immediately after a successful statistics write. Reconnects automatically; a two-second check observes writes from other API workers, and a 15-second heartbeat also refreshes this connection's presence for `online`. Keep proxy buffering disabled |
| [`GET /platforms`](#get-apiv1platforms) | Supported platforms and their domains |
| [`GET /health`, `GET /health/ready`](#get-health) | Liveness and readiness probes |

### Which download method should I use?

| You want | Use |
|---|---|
| The fastest start, one request, nothing on the server's disk | `GET /stream?mode=stream` (the default) |
| It to just work for every source, still one request | **`GET /stream?mode=auto`** (recommended) |
| A guaranteed H.264/AAC file | `GET /stream?mode=prepare` |
| A progress bar driven by the server while a long file is prepared | `POST /download`, then poll `GET /jobs/:id` |

## Platform status

Verified with real downloads against live URLs, not just metadata calls. Per-platform response examples are in [Responses by platform](#responses-by-platform). "Confirmed" means a
real video/audio file was downloaded and ffprobe-validated (correct streams, valid duration).

| Platform | Status | Notes |
|---|---|---|
| YouTube | ✅ Confirmed | Video, playlists (flat listing), best-quality auto-select. Uses a fallback provider automatically if YouTube blocks the server's IP |
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
| Newgrounds | ✅ Confirmed | Public movies with a video; ones with no video return a clear `MEDIA_NOT_FOUND` |
| Tumblr | ⚠️ Wired, untested | |
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
| `MEDIA_NOT_FOUND` | 404 | Extractor found nothing at the URL (deleted, removed or never existed) |
| `MEDIA_UNAVAILABLE` | 410 | Was stored earlier, but re-checks found it gone. `error.details.tombstone` says what it was |
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
| `TURNSTILE_REQUIRED` | 403 | Turnstile is on and this visitor has no valid pass. Solve the widget, call `POST /turnstile/verify`, retry |
| `TURNSTILE_FAILED` | 403 | Cloudflare rejected the token (or could not be reached) |
| `JOB_NOT_FOUND` | 404 | Job id doesn't exist or isn't ready yet |

> [!NOTE]
> Raw yt-dlp output is never returned to the client. It is logged server-side against the `requestId`.

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
| `forceRefresh` | boolean | no | Skip the stored copy and extract again now (the stored copy is replaced) |
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

### Response fields

| Field | Type | Meaning |
|---|---|---|
| `success` | boolean | Always `true` on `200` |
| `platform` | string | `youtube`, `tiktok`, `instagram`, `twitter`, `facebook`, `vimeo`, `reddit`, `soundcloud`, `pinterest`, `snapchat`, `dailymotion`, `bluesky`, `loom`, `newgrounds`, `rutube`, `streamable`, `twitch`, `tumblr` |
| `mediaType` | string | `video`, `audio`, `image`, `carousel` (several items, e.g. a Pinterest board) or `playlist` |
| `mediaId` | string | The platform's own id for the media. Also the last part of `stored.path` |
| `canonicalUrl` | string | The cleaned-up URL (tracking parameters removed, short links resolved) |
| `title`, `description`, `thumbnail` | string | When the platform provides them |
| `author` | object | `{ name, url }` of the uploader |
| `durationSeconds` | number or null | Length in seconds (`null` when unknown) |
| `uploadDate` | string | `YYYYMMDD`, when known |
| `formats` | array | Video options, see below |
| `audioFormats` | array | Audio-only options, see below |
| `items` | array | For `carousel`: one entry per photo/video, each with its own `formats` or `source` |
| `playlist` | object | For `playlist`: `{ title, channel, itemCount, items: [{ videoId, title, thumbnail, durationSeconds, url }] }` |
| `metadata` | object | Extra platform details (for example `isLive`, or paging info for boards) |
| `extractor` | string | Who produced the answer: `yt-dlp` or a fallback provider name |
| `fallbackUsed` | string | Set when a fallback provider (not yt-dlp) produced the answer |
| `stored` | object | Stable path, freshness and statistics. See [Stored media](#stored-media-and-stable-paths) |

**`formats[]`**

| Field | Meaning |
|---|---|
| `formatId` | Pass this back as `formatId` when downloading (or use `"best"`) |
| `ext`, `quality`, `width`, `height`, `fps` | Container, label and size of the video |
| `kind` | `video` (audio included) or `video_only` (needs a merge) |
| `requiresMerge` | `true` for video-only formats: the server adds the best AAC audio automatically |
| `compatible` | `true` when the codec is broadly playable without transcoding (H.264 video, AAC audio) |
| `bitrate` (kbps), `codec`, `filesizeBytes`, `filesizeApprox` | Technical details when known |
| `url` | Direct link at the source. It expires (`stored.urlsStale`); use `formatId` with the download endpoints instead of relying on it |

**`audioFormats[]`**: `formatId`, `ext`, `bitrate`, `codec`, `quality`, `filesizeBytes`, `isConverted`
(`true` when the audio must be produced with ffmpeg, e.g. `mp3-from-<formatId>`) and `url`.

Real examples for every platform, including playlists and a Pinterest board, are in [Responses by platform](#responses-by-platform) below.

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

```json
{
  "success": false,
  "error": { "code": "MEDIA_UNAVAILABLE", "message": "This media is no longer available at the source.",
             "details": { "tombstone": { "platform": "youtube", "path": "/youtube/abc", "title": "...", "reason": "MEDIA_NOT_FOUND" } } },
  "requestId": "e6c4..."
}
```

A `429` from the platform, for example when a site blocks the server's IP for a while:

```json
{
  "success": false,
  "error": { "code": "PLATFORM_RATE_LIMITED", "message": "The source platform is rate-limiting requests." },
  "requestId": "f7d5..."
}
```

---


## Responses by platform

Real responses captured from the running API (one `POST /api/v1/fetch` per platform), trimmed for
readability. They show what each platform actually returns, including the platform-specific quirks.
Every successful response also carries the [`stored` block](#stored-media-and-stable-paths) with the
media's stable `path`.

| Platform | Media type | Formats you get | Merge needed | Separate audio |
|---|---|---|---|---|
| [YouTube](#youtube) | video, playlist | 1 muxed + many video-only | yes (most) | yes |
| [TikTok](#tiktok) | video | muxed | no | 1 |
| [Instagram](#instagram-reel) | video (reels, posts) | muxed + video-only DASH | yes (DASH) | 1 |
| [X / Twitter](#x--twitter) | video | muxed + video-only | some | yes |
| [Facebook](#facebook) | video (reels, videos) | muxed + video-only DASH | some | 1 |
| [Reddit](#reddit) | video | video-only DASH | yes (all) | yes |
| [Vimeo](#vimeo) | video | video-only HLS/DASH | yes (all) | yes |
| [Dailymotion](#dailymotion) | video | muxed HLS | no | no |
| [Bluesky](#bluesky) | video | HLS + original | no | no |
| [Streamable](#streamable) | video | muxed MP4 | no | no |
| [Rutube](#rutube) | video | muxed HLS | no | no |
| [SoundCloud](#soundcloud-single-track) | audio | none (audio only) | no | yes |
| [Snapchat](#snapchat-spotlight) | video | 1 MP4 | no | no |
| [Twitch](#twitch-vod) | video (VOD) | muxed HLS | no | 1 |
| [Pinterest](#pinterest-video-pin) | pin, board | muxed + video-only, board = carousel | some | 1 |
| [Loom](#loom) | video | video-only HLS | yes | 1 |
| [Newgrounds](#newgrounds) | video | muxed | no | no |
| Tumblr | video | not verified yet | | |

`formats[].kind` is `video` (audio included), `video_only` (needs `requiresMerge`) and `audioFormats`
lists audio-only tracks. Pass `"formatId": "best"` (or omit it) when downloading to skip picking.

### YouTube

`POST /api/v1/fetch` with `{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}`

- One muxed format (`18`, 360p) plus many **video-only** formats (`requiresMerge: true`): pick one and the server pairs it with the best AAC audio automatically. `compatible: true` marks H.264 video.
- Accepts `watch`, `youtu.be`, `shorts`, `live` and `embed` URLs. `mediaId` is the 11-character video id, and the stable path is `/youtube/<id>`.
- A URL with both `v=` and `list=` returns the **video**; `stored.playlistPath` then points at the playlist in that video's context.

_Trimmed for readability: showing 2 of 38 formats, 1 of 7 audio formats. Long URLs are cut with `...`. Full trimmed file: [`examples/youtube.json`](examples/youtube.json)._

```json
{
  "success": true,
  "platform": "youtube",
  "mediaType": "video",
  "mediaId": "dQw4w9WgXcQ",
  "canonicalUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
  "description": "The official video for “Never Gonna Give You Up” by Rick Astley. \n\nNever: The Autobiography 📚 OUT NOW! \nFollow this link to get your copy...",
  "author": {"name": "Rick Astley", "url": "https://www.youtube.com/@RickAstleyYT"},
  "thumbnail": "https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp",
  "durationSeconds": 213,
  "uploadDate": "20091025",
  "formats": [
    {"formatId": "394", "ext": "mp4", "kind": "video_only", "quality": "144p", "width": 256, "height": 144, "fps": 25, "bitrate": 56.534, "codec": "av01.0.00M.08", "filesizeBytes": 1505504, "filesizeApprox": false, "url": "https://rr1---sn-o5t5uxa-pnck.googlevideo.com/videoplayback?expire=1790298525&ei=PXW1ar_5FfSr8uM...", "requiresMerge": true, "compatible": false},
    {"formatId": "625", "ext": "mp4", "kind": "video_only", "quality": "3840x2160", "width": 3840, "height": 2160, "fps": 25, "bitrate": 19117.677, "codec": "vp09.00.50.08", "filesizeApprox": false, "url": "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1790298525/ei/PXW1ar_5FfSr8uMP...", "requiresMerge": true, "compatible": false}
  ],
  "audioFormats": [
    {"formatId": "233", "ext": "mp4", "bitrate": null, "quality": "Default, low", "filesizeApprox": false, "isConverted": false, "url": "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1790298525/ei/PXW1ar_5FfSr8uMP..."}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/youtube/dQw4w9WgXcQ",
    "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:08:54.620Z",
    "lastFetchedAt": "2026-09-24T19:08:54.620Z",
    "validatedAt": "2026-09-24T19:08:54.620Z",
    "nextCheckAt": "2026-10-01T19:08:54.620Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### YouTube: the same request again (answered from the database)

`POST /api/v1/fetch` with `{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}`

Fetching something already stored is answered from the database in milliseconds. The only difference is the `stored` block: `cached: true` and updated counters (`hitCount`, `viewCount`, ...).

_Trimmed for readability: showing 2 of 38 formats, 1 of 7 audio formats. Long URLs are cut with `...`. Full trimmed file: [`examples/youtube-cached.json`](examples/youtube-cached.json)._

```json
{
  "success": true,
  "platform": "youtube",
  "mediaType": "video",
  "mediaId": "dQw4w9WgXcQ",
  "canonicalUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
  "description": "The official video for “Never Gonna Give You Up” by Rick Astley. \n\nNever: The Autobiography 📚 OUT NOW! \nFollow this link to get your copy...",
  "author": {"name": "Rick Astley", "url": "https://www.youtube.com/@RickAstleyYT"},
  "thumbnail": "https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp",
  "durationSeconds": 213,
  "uploadDate": "20091025",
  "formats": [
    {"formatId": "394", "ext": "mp4", "kind": "video_only", "quality": "144p", "width": 256, "height": 144, "fps": 25, "bitrate": 56.534, "codec": "av01.0.00M.08", "filesizeBytes": 1505504, "filesizeApprox": false, "url": "https://rr1---sn-o5t5uxa-pnck.googlevideo.com/videoplayback?expire=1790298525&ei=PXW1ar_5FfSr8uM...", "requiresMerge": true, "compatible": false},
    {"formatId": "625", "ext": "mp4", "kind": "video_only", "quality": "3840x2160", "width": 3840, "height": 2160, "fps": 25, "bitrate": 19117.677, "codec": "vp09.00.50.08", "filesizeApprox": false, "url": "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1790298525/ei/PXW1ar_5FfSr8uMP...", "requiresMerge": true, "compatible": false}
  ],
  "audioFormats": [
    {"formatId": "233", "ext": "mp4", "bitrate": null, "quality": "Default, low", "filesizeApprox": false, "isConverted": false, "url": "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1790298525/ei/PXW1ar_5FfSr8uMP..."}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/youtube/dQw4w9WgXcQ",
    "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "status": "available",
    "cached": true,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:08:54.620Z",
    "lastFetchedAt": "2026-09-24T19:08:54.620Z",
    "validatedAt": "2026-09-24T19:08:54.620Z",
    "nextCheckAt": "2026-10-01T19:08:54.620Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### YouTube playlist

`POST /api/v1/fetch` with `{"url": "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"}`

- `mediaType: "playlist"`. Items come from a fast flat listing (no formats per item); fetch an item's own `url` to get its formats.
- Limited to `MAX_PLAYLIST_ITEMS` (default 200); `itemCount` is the number returned. Stable path: `/youtube/playlist/<listId>`.

_Trimmed for readability: showing 2 of 183 playlist items. Long URLs are cut with `...`. Full trimmed file: [`examples/youtube-playlist.json`](examples/youtube-playlist.json)._

```json
{
  "success": true,
  "platform": "youtube",
  "mediaType": "playlist",
  "mediaId": "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
  "canonicalUrl": "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
  "title": "Popular Music Videos",
  "thumbnail": "https://i.ytimg.com/vi/fOT0BUpITw8/hqdefault.jpg?sqp=-oaymwEXCNACELwBSFryq4qpAwkIARUAAIhCGAE=&rs...",
  "isPlaylist": true,
  "itemCount": 183,
  "playlist": {
    "title": "Popular Music Videos",
    "thumbnail": "https://i.ytimg.com/vi/fOT0BUpITw8/hqdefault.jpg?sqp=-oaymwEXCNACELwBSFryq4qpAwkIARUAAIhCGAE=&rs...",
    "channel": "Music",
    "itemCount": 183,
    "items": [
      {"videoId": "fOT0BUpITw8", "title": "BELLAKEO (Video Oficial) - Peso Pluma, Anitta", "thumbnail": "https://i.ytimg.com/vi/fOT0BUpITw8/hqdefault.jpg?sqp=-oaymwEcCNACELwBSFXyq4qpAw4IARUAAIhCGAFwAcA...", "durationSeconds": 235, "url": "https://www.youtube.com/watch?v=fOT0BUpITw8"},
      {"videoId": "NFvDHYMzj9U", "title": "Arcángel - FN8 ( Video Lyric )", "thumbnail": "https://i.ytimg.com/vi/NFvDHYMzj9U/hqdefault.jpg?sqp=-oaymwE2CNACELwBSFXyq4qpAygIARUAAIhCGAFwAcA...", "durationSeconds": 650, "url": "https://www.youtube.com/watch?v=NFvDHYMzj9U"}
    ]
  },
  "formats": [],
  "audioFormats": [],
  "metadata": {},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/youtube/playlist/PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
    "sourceUrl": "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:09:14.511Z",
    "lastFetchedAt": "2026-09-24T19:09:14.511Z",
    "validatedAt": "2026-09-24T19:09:14.511Z",
    "nextCheckAt": "2026-10-01T19:09:14.511Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### YouTube when YouTube blocks the server (fallback provider)

`POST /api/v1/fetch` with `{"url": "https://www.youtube.com/watch?v=Cwkej79U3ek"}`

When YouTube temporarily blocks the server's IP ("confirm you're not a bot"), a fallback provider answers instead: `extractor` and `fallbackUsed` say `btch-downloader`, there is one video format (`btch-mp4`) and one audio format (`btch-m4a`), and quality is limited to what the provider offers. Its links expire within a minute, so a stored answer like this is trusted for only `FALLBACK_LINK_TTL_SECONDS`. See [YouTube blocks and the fallback provider](#youtube-blocks-and-the-fallback-provider).

```json
{
  "success": true,
  "platform": "youtube",
  "mediaType": "video",
  "mediaId": "Cwkej79U3ek",
  "canonicalUrl": "https://www.youtube.com/watch?v=Cwkej79U3ek",
  "title": "Vanessa Carlton - A Thousand Miles",
  "thumbnail": "https://i.ytimg.com/vi/Cwkej79U3ek/hqdefault.jpg",
  "author": {"name": "VanessaCarltonVEVO"},
  "formats": [
    {"formatId": "btch-mp4", "ext": "mp4", "kind": "video", "quality": "best available", "url": "https://c.ymcdn.org/api/v2/download/c5f30166974e83561468bf089a29c4eb/Cwkej79U3ek?_=QohKIyk7RleG2...", "compatible": true}
  ],
  "audioFormats": [
    {"formatId": "btch-m4a", "ext": "m4a", "isConverted": false, "quality": "aac", "url": "https://c.ymcdn.org/api/v2/download/c5f30166974e83561468bf089a29c4eb/Cwkej79U3ek?_=rXKspGtVZqJ5s..."}
  ],
  "metadata": {},
  "extractor": "btch-downloader",
  "fallbackUsed": "btch-downloader",
  "stored": {
    "path": "/youtube/Cwkej79U3ek",
    "sourceUrl": "https://www.youtube.com/watch?v=Cwkej79U3ek",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:09:08.284Z",
    "lastFetchedAt": "2026-09-24T19:09:08.284Z",
    "validatedAt": "2026-09-24T19:09:08.284Z",
    "nextCheckAt": "2026-10-01T19:09:08.283Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### TikTok

`POST /api/v1/fetch` with `{"url": "https://www.tiktok.com/@scout2015/video/6718335390845095173"}`

- Several muxed formats (H.264 and other codecs); `compatible: true` marks the H.264 ones. No merge needed. Short links such as `vm.tiktok.com` are accepted.
- yt-dlp is primary; `@tobyg74/tiktok-api-dl` is the fallback (then `fallbackUsed` is set).

_Trimmed for readability: showing 2 of 10 formats. Long URLs are cut with `...`. Full trimmed file: [`examples/tiktok.json`](examples/tiktok.json)._

```json
{
  "success": true,
  "platform": "tiktok",
  "mediaType": "video",
  "mediaId": "6718335390845095173",
  "canonicalUrl": "https://www.tiktok.com/@scout2015/video/6718335390845095173",
  "title": "Scramble up ur name & I’ll try to guess it😍❤️ #foryoupage #petsoftikt...",
  "description": "Scramble up ur name & I’ll try to guess it😍❤️ #foryoupage #petsoftiktok #aesthetic",
  "author": {"name": "scout2015", "url": "https://www.tiktok.com/@scout2015"},
  "thumbnail": "https://p16-common-sign.tiktokcdn.com/tos-maliva-p-0068/8ac0190d8ad54535bf823ed5f3202b6b~tplv-ti...",
  "durationSeconds": 10,
  "uploadDate": "20190727",
  "formats": [
    {"formatId": "h264_540p_992286-0", "ext": "mp4", "kind": "video", "quality": "576x1024", "width": 576, "height": 1024, "bitrate": 992, "codec": "h264", "filesizeBytes": 1307586, "filesizeApprox": false, "url": "https://v16-webapp-prime.tiktok.com/video/tos/alisg/tos-alisg-ve-37c799-sg/b061a7d5c4c74a028371c...", "requiresMerge": false, "compatible": true},
    {"formatId": "bytevc1_720p_1504834-1", "ext": "mp4", "kind": "video", "quality": "720x1280", "width": 720, "height": 1280, "bitrate": 1504, "codec": "h265", "filesizeBytes": 2004627, "filesizeApprox": false, "url": "https://v19-webapp-prime.tiktok.com/video/tos/alisg/tos-alisg-ve-37c799-sg/c9f7a85bfdd7452aaffab...", "requiresMerge": false, "compatible": false}
  ],
  "audioFormats": [
    {"formatId": "audio", "ext": "mp3", "bitrate": null, "codec": "mp3", "filesizeBytes": null, "filesizeApprox": false, "isConverted": false, "url": "https://v58.tiktokcdn.com/video/tos/useast2a/tos-useast2a-v-27dcd7/fdec9588d6684e7d97da29739b9d0..."}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/tiktok/6718335390845095173",
    "sourceUrl": "https://www.tiktok.com/@scout2015/video/6718335390845095173",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:09:19.639Z",
    "lastFetchedAt": "2026-09-24T19:09:19.639Z",
    "validatedAt": "2026-09-24T19:09:19.639Z",
    "nextCheckAt": "2026-10-01T19:09:19.639Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Instagram (reel)

`POST /api/v1/fetch` with `{"url": "https://www.instagram.com/reel/DZYvGYIv1nr/"}`

- Reels, posts and TV. DASH formats are **video-only** (`requiresMerge: true`) and get their audio merged automatically; a few muxed formats are also offered.
- `durationSeconds` can be `null`. `mediaId` is the shortcode, so `/instagram/<shortcode>` works for reels and posts alike. Profile listing is not supported.
- Fallback providers (btch-downloader, then an optional cakkatrok endpoint) take over when yt-dlp is blocked, and `fallbackUsed` is set.

_Trimmed for readability: showing 2 of 11 formats. Long URLs are cut with `...`. Full trimmed file: [`examples/instagram.json`](examples/instagram.json)._

```json
{
  "success": true,
  "platform": "instagram",
  "mediaType": "video",
  "mediaId": "DZYvGYIv1nr",
  "canonicalUrl": "https://www.instagram.com/reel/DZYvGYIv1nr",
  "title": "Video by nasa",
  "description": "Get ready for Earth joy!\n\nEarlier today, we announced the four astronauts who will go to space as part of Artemis III. The four crew memb...",
  "author": {"name": "NASA"},
  "thumbnail": "https://instagram.fisb1-2.fna.fbcdn.net/v/t51.82787-15/720823070_18616586722049152_3387319240174...",
  "durationSeconds": null,
  "uploadDate": "20260610",
  "formats": [
    {"formatId": "1", "ext": "mp4", "kind": "video", "quality": null, "bitrate": null, "filesizeBytes": null, "filesizeApprox": false, "url": "https://instagram.fisb17-1.fna.fbcdn.net/o1/v/t2/f2/m86/AQMqJP2UYHhTDAmd1a0m5cG59yX0bsZ90xP3GaoR...", "requiresMerge": false, "compatible": false},
    {"formatId": "dash-1580359426785355v", "ext": "mp4", "kind": "video_only", "quality": "DASH video", "width": 1080, "height": 1920, "fps": null, "bitrate": 1619.782, "codec": "vp09.00.40.08.00.01.01.01.00", "filesizeBytes": null, "filesizeApprox": false, "url": "https://instagram.fisb17-1.fna.fbcdn.net/o1/v/t2/f2/m367/AQPy1iSi9CEXopxAsnO3MjmxzkCd7pXRfqSil96...", "requiresMerge": true, "compatible": false}
  ],
  "audioFormats": [
    {"formatId": "dash-1544861667001560a", "ext": "m4a", "bitrate": 63.635, "codec": "mp4a.40.5", "quality": "DASH audio", "filesizeBytes": null, "filesizeApprox": false, "isConverted": false, "url": "https://instagram.fisb17-1.fna.fbcdn.net/o1/v/t2/f2/m78/AQNxyOVDVb0RzSZSzMJ8V8cf-wQXrsI4iVwmu5uX..."}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/instagram/DZYvGYIv1nr",
    "sourceUrl": "https://www.instagram.com/reel/DZYvGYIv1nr/",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:09:26.301Z",
    "lastFetchedAt": "2026-09-24T19:09:26.301Z",
    "validatedAt": "2026-09-24T19:09:26.301Z",
    "nextCheckAt": "2026-10-01T19:09:26.301Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Multi-item posts (carousel shape)

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

### X / Twitter

`POST /api/v1/fetch` with `{"url": "https://x.com/BenGeskin/status/2102909808542154887/video/1"}`

- Works with `x.com` and legacy `twitter.com` URLs (and `t.co` short links). A tweet without a video returns an error.
- Muxed formats plus video-only formats that need a merge, and separate HLS audio tracks.

_Trimmed for readability: showing 2 of 6 formats, 1 of 3 audio formats. Long URLs are cut with `...`. Full trimmed file: [`examples/twitter.json`](examples/twitter.json)._

```json
{
  "success": true,
  "platform": "twitter",
  "mediaType": "video",
  "mediaId": "2102909714132508672",
  "canonicalUrl": "https://x.com/BenGeskin/status/2102909808542154887/video/1",
  "title": "Ben Geskin - This is exactly what I’ve been waiting for 🔥  Meta just announced its...",
  "description": "This is exactly what I’ve been waiting for 🔥  Meta just announced its new VR Glasses. Basically an Apple Vision Pro-like experience, but ...",
  "author": {"name": "Ben Geskin", "url": "https://twitter.com/BenGeskin"},
  "thumbnail": "https://pbs.twimg.com/amplify_video_thumb/2102909714132508672/img/ES0qFlpiERcNTZj-.jpg?name=orig",
  "durationSeconds": 69.314,
  "uploadDate": "20260923",
  "formats": [
    {"formatId": "hls-105", "ext": "mp4", "kind": "video_only", "quality": "480x270", "width": 480, "height": 270, "fps": null, "bitrate": 105.758, "codec": "avc1.4D4015", "filesizeApprox": false, "url": "https://video.twimg.com/amplify_video/2102909714132508672/pl/avc1/480x270/HPRhEq7Opc_KYk5M.m3u8", "requiresMerge": true, "compatible": true},
    {"formatId": "http-2176", "ext": "mp4", "kind": "video", "quality": "1280x720", "width": 1280, "height": 720, "bitrate": 2176, "filesizeBytes": 18853408, "filesizeApprox": true, "url": "https://video.twimg.com/amplify_video/2102909714132508672/vid/avc1/1280x720/eD2VgAMpNh9c9VQy.mp4...", "requiresMerge": false, "compatible": false}
  ],
  "audioFormats": [
    {"formatId": "hls-audio-32000-Audio", "ext": "mp4", "bitrate": 32, "quality": "Audio, low", "filesizeApprox": false, "isConverted": false, "url": "https://video.twimg.com/amplify_video/2102909714132508672/pl/mp4a/32000/sQDZF5shczK7C3DD.m3u8"}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/twitter/2102909714132508672",
    "sourceUrl": "https://x.com/BenGeskin/status/2102909808542154887/video/1",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:09:39.157Z",
    "lastFetchedAt": "2026-09-24T19:09:39.157Z",
    "validatedAt": "2026-09-24T19:09:39.157Z",
    "nextCheckAt": "2026-10-01T19:09:39.157Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Facebook

`POST /api/v1/fetch` with `{"url": "https://www.facebook.com/reel/1097374499488415"}`

- Reels and public videos, including `share/v/...` and `fb.watch` links (a share link is followed to the post). Two muxed formats plus DASH video-only formats that merge with the separate audio track.
- Facebook often gates content; posts that need a login return `LOGIN_REQUIRED` or `MEDIA_NOT_FOUND`.

_Trimmed for readability: showing 2 of 6 formats. Long URLs are cut with `...`. Full trimmed file: [`examples/facebook.json`](examples/facebook.json)._

```json
{
  "success": true,
  "platform": "facebook",
  "mediaType": "video",
  "mediaId": "1097374499488415",
  "canonicalUrl": "https://m.facebook.com/watch/?v=1097374499488415&_rdr",
  "title": "232K views · 76K reactions | تفريغ البيانات من ورقة لبرنامج الاكسيل بكل سهولة. Extract Data from Paper Using Your Camera in Excel! #learnontiktok #excel #exceltips #exceltricks #data | Hussein Adel",
  "description": "تفريغ البيانات من ورقة لبرنامج الاكسيل بكل سهولة.\nExtract Data from Paper Using Your Camera in Excel!\n\n #learnontiktok #excel #exceltips ...",
  "author": {"name": "Hussein Adel"},
  "thumbnail": "https://scontent.fisb1-2.fna.fbcdn.net/v/t51.82787-10/801284054_18625495702055500_67742985960207...",
  "durationSeconds": 58.235,
  "uploadDate": "20260908",
  "formats": [
    {"formatId": "sd", "ext": "mp4", "kind": "video", "quality": null, "bitrate": null, "filesizeBytes": null, "filesizeApprox": false, "url": "https://video.fisb17-1.fna.fbcdn.net/o1/v/t2/f2/m367/AQMkPq3e_vXQxe0KzT3rIZXj_hZENa1hbGiHtSBSx9S...", "requiresMerge": false, "compatible": false},
    {"formatId": "1465289862165722v", "ext": "mp4", "kind": "video_only", "quality": "DASH video", "width": 1080, "height": 1920, "fps": null, "bitrate": 659.654, "codec": "av01.0.08M.08.0.111.01.01.01.0", "filesizeApprox": false, "url": "https://video.fisb1-2.fna.fbcdn.net/o1/v/t2/f2/m367/AQOge4tMa-JFby81FQNULOAQVfETdb9QvaG8xyEvuFqA...", "requiresMerge": true, "compatible": false}
  ],
  "audioFormats": [
    {"formatId": "1465249215503120a", "ext": "m4a", "bitrate": 56.698, "codec": "mp4a.40.5", "quality": "DASH audio", "filesizeApprox": false, "isConverted": false, "url": "https://video.fisb1-2.fna.fbcdn.net/o1/v/t2/f2/m78/AQM9UaGP7t5i_qsKutF1KGgSAZQ81corg7yBwx5SaNGl5..."}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/facebook/1097374499488415",
    "sourceUrl": "https://www.facebook.com/reel/1097374499488415",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:09:44.647Z",
    "lastFetchedAt": "2026-09-24T19:09:44.647Z",
    "validatedAt": "2026-09-24T19:09:44.647Z",
    "nextCheckAt": "2026-10-01T19:09:44.647Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Reddit

`POST /api/v1/fetch` with `{"url": "https://www.reddit.com/r/funny/comments/1bx4vqy/in_hot_pursuit/"}`

Native Reddit video is DASH: every video format is **video-only** (`requiresMerge: true`) with separate audio formats, and the server merges them for you. `redd.it` short links are accepted.

_Trimmed for readability: showing 2 of 10 formats, 1 of 4 audio formats. Long URLs are cut with `...`. Full trimmed file: [`examples/reddit.json`](examples/reddit.json)._

```json
{
  "success": true,
  "platform": "reddit",
  "mediaType": "video",
  "mediaId": "vq983vm21tsc1",
  "canonicalUrl": "https://www.reddit.com/r/funny/comments/1bx4vqy/in_hot_pursuit",
  "title": "In hot pursuit.",
  "author": {"name": "xgodlesssaintx"},
  "durationSeconds": 66,
  "uploadDate": "20240406",
  "formats": [
    {"formatId": "dash-1", "ext": "mp4", "kind": "video_only", "quality": "DASH video", "width": 392, "height": 214, "fps": null, "bitrate": 214.274, "codec": "avc1.4d401e", "filesizeApprox": false, "url": "https://v.redd.it/vq983vm21tsc1/DASH_220.mp4", "requiresMerge": true, "compatible": true},
    {"formatId": "fallback", "ext": "mp4", "kind": "video_only", "quality": "DASH video, mp4_dash", "width": 640, "height": 350, "bitrate": 800, "codec": "h264", "filesizeBytes": 6600000, "filesizeApprox": true, "url": "https://v.redd.it/vq983vm21tsc1/DASH_360.mp4?source=fallback", "requiresMerge": true, "compatible": true}
  ],
  "audioFormats": [
    {"formatId": "hls-3-audio_0", "ext": "mp4", "bitrate": null, "quality": "audio 0, low", "filesizeApprox": false, "isConverted": false, "url": "https://v.redd.it/vq983vm21tsc1/HLS_AUDIO_64.m3u8"}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/reddit/vq983vm21tsc1",
    "sourceUrl": "https://www.reddit.com/r/funny/comments/1bx4vqy/in_hot_pursuit/",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:09:51.772Z",
    "lastFetchedAt": "2026-09-24T19:09:51.772Z",
    "validatedAt": "2026-09-24T19:09:51.772Z",
    "nextCheckAt": "2026-10-01T19:09:51.772Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Vimeo

`POST /api/v1/fetch` with `{"url": "https://vimeo.com/826026805"}`

- HLS/DASH video-only formats (merge required) plus audio formats. If the watch page needs a login, the server retries through the public player URL automatically.
- DRM-protected videos cannot be downloaded and return `FORMAT_UNAVAILABLE`.

_Trimmed for readability: showing 2 of 18 formats, 1 of 4 audio formats. Long URLs are cut with `...`. Full trimmed file: [`examples/vimeo.json`](examples/vimeo.json)._

```json
{
  "success": true,
  "platform": "vimeo",
  "mediaType": "video",
  "mediaId": "826026805",
  "canonicalUrl": "https://player.vimeo.com/video/826026805",
  "title": "Generation Vimeo - Celebrating 15 Years of Staff Picks",
  "author": {"name": "Vimeo Curation", "url": "https://vimeo.com/vimeocuration"},
  "thumbnail": "https://i.vimeocdn.com/video/1668695278-729a83f90922565e20a722487b89ef8c0787ff3cf48afe9f437f3d42...",
  "durationSeconds": 159,
  "formats": [
    {"formatId": "hls-akfire_interconnect_quic-408", "ext": "mp4", "kind": "video_only", "quality": "426x240", "width": 426, "height": 240, "fps": 23.976, "bitrate": 408, "codec": "avc1.640015", "filesizeApprox": false, "url": "https://vod-adaptive-ak.vimeocdn.com/exp=1790280597~acl=%2Fdea9d61e-4ed6-4453-9d56-4c3d0db49cf0%...", "requiresMerge": true, "compatible": true},
    {"formatId": "hls-fastly_skyfire-5357", "ext": "mp4", "kind": "video_only", "quality": "1920x1080", "width": 1920, "height": 1080, "fps": 23.976, "bitrate": 5357, "codec": "avc1.64002A", "filesizeApprox": false, "url": "https://skyfire.vimeocdn.com/1790280597-0x6ecce6205b8e9c9264839cbdd10f19c9329e5f63/dea9d61e-4ed6...", "requiresMerge": true, "compatible": true}
  ],
  "audioFormats": [
    {"formatId": "hls-akfire_interconnect_quic-audio-low-Original", "ext": "mp4", "bitrate": null, "quality": "Original, low", "filesizeApprox": false, "isConverted": false, "url": "https://vod-adaptive-ak.vimeocdn.com/exp=1790280597~acl=%2Fdea9d61e-4ed6-4453-9d56-4c3d0db49cf0%..."}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/vimeo/826026805",
    "sourceUrl": "https://vimeo.com/826026805",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:10:00.186Z",
    "lastFetchedAt": "2026-09-24T19:10:00.186Z",
    "validatedAt": "2026-09-24T19:10:00.186Z",
    "nextCheckAt": "2026-10-01T19:10:00.186Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Dailymotion

`POST /api/v1/fetch` with `{"url": "https://www.dailymotion.com/video/x84sh87"}`

Four muxed HLS formats (288p to 1080p) and **no separate audio formats**: the audio is inside the video. Some clips have no audio at the source.

_Trimmed for readability: showing 2 of 4 formats. Long URLs are cut with `...`. Full trimmed file: [`examples/dailymotion.json`](examples/dailymotion.json)._

```json
{
  "success": true,
  "platform": "dailymotion",
  "mediaType": "video",
  "mediaId": "x84sh87",
  "canonicalUrl": "https://www.dailymotion.com/video/x84sh87",
  "title": "Dailymotion demo video",
  "description": "",
  "author": {"name": "Dailymotion"},
  "thumbnail": "https://s2.dmcdn.net/v/TJ-et1gM9ma29OOy8/x1080",
  "durationSeconds": 25,
  "uploadDate": "20211011",
  "formats": [
    {"formatId": "hls-380", "ext": "mp4", "kind": "video", "quality": "512x288", "width": 512, "height": 288, "fps": null, "bitrate": 460.56, "codec": "avc1.42001e", "filesizeApprox": false, "url": "https://vod3.cf.dmcdn.net/sec2(DeyrKU57lyyNj5se3eeL0x_lWcEZ6pfRLP1E7vOiXAAtfPNJJ9JEWR8yAIcObWXAj...", "requiresMerge": false, "compatible": true},
    {"formatId": "hls-1080", "ext": "mp4", "kind": "video", "quality": "1920x1080", "width": 1920, "height": 1080, "fps": null, "bitrate": 6221.6, "codec": "avc1.640028", "filesizeApprox": false, "url": "https://vod3.cf.dmcdn.net/sec2(3O4NYZpyhz3FwHhynqXQY8EL6jgCATNA9JLL-eTlAI2iAEIhHqO3cCFFhtPn_-z74...", "requiresMerge": false, "compatible": true}
  ],
  "audioFormats": [],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/dailymotion/x84sh87",
    "sourceUrl": "https://www.dailymotion.com/video/x84sh87",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:10:07.115Z",
    "lastFetchedAt": "2026-09-24T19:10:07.115Z",
    "validatedAt": "2026-09-24T19:10:07.115Z",
    "nextCheckAt": "2026-10-01T19:10:07.115Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Bluesky

`POST /api/v1/fetch` with `{"url": "https://bsky.app/profile/bsky.app/post/3l3vgf77uco2g"}`

Video posts only. Two HLS renditions (`hls-655`, `hls-1240`) and the original upload (`blob`, up to 1080p). `durationSeconds` is `null`; there are no separate audio formats.

_Trimmed for readability: showing 2 of 3 formats. Long URLs are cut with `...`. Full trimmed file: [`examples/bluesky.json`](examples/bluesky.json)._

```json
{
  "success": true,
  "platform": "bluesky",
  "mediaType": "video",
  "mediaId": "3l3vgf77uco2g",
  "canonicalUrl": "https://bsky.app/profile/bsky.app/post/3l3vgf77uco2g",
  "title": "Bluesky now has video! Update your app to version 1.91 or refresh on ...",
  "description": "Bluesky now has video! Update your app to version 1.91 or refresh on desktop!\n\nWe’ve begun gradually rolling out the ability to post vide...",
  "author": {"name": "Bluesky", "url": "https://bsky.app/profile/bsky.app"},
  "thumbnail": "https://video.bsky.app/watch/did%3Aplc%3Az72i7hdynmk6r22z27h6tvur/bafkreih7qpo7ef7hhtm7ehi7paiml...",
  "durationSeconds": null,
  "uploadDate": "20240911",
  "formats": [
    {"formatId": "hls-655", "ext": "mp4", "kind": "video", "quality": "640x360", "width": 640, "height": 360, "fps": null, "bitrate": 655.6, "codec": "avc1.64001e", "filesizeApprox": false, "url": "https://video.bsky.app/watch/did%3Aplc%3Az72i7hdynmk6r22z27h6tvur/bafkreih7qpo7ef7hhtm7ehi7paiml...", "requiresMerge": false, "compatible": true},
    {"formatId": "blob", "ext": "mp4", "kind": "video", "quality": "1920x1080", "width": 1920, "height": 1080, "bitrate": null, "filesizeBytes": 6688967, "filesizeApprox": false, "url": "https://puffball.us-east.host.bsky.network/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Az72i7hd...", "requiresMerge": false, "compatible": false}
  ],
  "audioFormats": [],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/bluesky/3l3vgf77uco2g",
    "sourceUrl": "https://bsky.app/profile/bsky.app/post/3l3vgf77uco2g",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:10:13.791Z",
    "lastFetchedAt": "2026-09-24T19:10:13.791Z",
    "validatedAt": "2026-09-24T19:10:13.791Z",
    "nextCheckAt": "2026-10-01T19:10:13.791Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Streamable

`POST /api/v1/fetch` with `{"url": "https://streamable.com/hn8hq"}`

Two muxed MP4 files (`mp4-mobile`, `mp4`). The simplest response shape: no merge, no audio list.

```json
{
  "success": true,
  "platform": "streamable",
  "mediaType": "video",
  "mediaId": "hn8hq",
  "canonicalUrl": "https://streamable.com/hn8hq",
  "title": "Gravity Rush 2's world traversal is so goddamn addictive. [Video]",
  "description": "",
  "author": {},
  "thumbnail": "https://cdn-cf-east.streamable.com/image/hn8hq.jpg?Expires=1790284186266&Key-Pair-Id=APKAIEYUVEN...",
  "durationSeconds": 24.002,
  "uploadDate": "20170208",
  "formats": [
    {"formatId": "mp4-mobile", "ext": "mp4", "kind": "video", "quality": "640x360", "width": 640, "height": 360, "fps": 30, "bitrate": null, "codec": "h264", "filesizeBytes": 4746054, "filesizeApprox": false, "url": "https://cdn-cf-east.streamable.com/video/mp4-mobile/hn8hq.mp4?Expires=1790536186263&Key-Pair-Id=...", "requiresMerge": false, "compatible": true},
    {"formatId": "mp4", "ext": "mp4", "kind": "video", "quality": "1280x720", "width": 1280, "height": 720, "fps": 30, "bitrate": null, "codec": "h264", "filesizeBytes": 14230108, "filesizeApprox": false, "url": "https://cdn-cf-east.streamable.com/video/mp4/hn8hq.mp4?Expires=1790536186264&Key-Pair-Id=APKAIEY...", "requiresMerge": false, "compatible": true}
  ],
  "audioFormats": [],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/streamable/hn8hq",
    "sourceUrl": "https://streamable.com/hn8hq",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:10:19.360Z",
    "lastFetchedAt": "2026-09-24T19:10:19.360Z",
    "validatedAt": "2026-09-24T19:10:19.360Z",
    "nextCheckAt": "2026-10-01T19:10:19.360Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Rutube

`POST /api/v1/fetch` with `{"url": "https://rutube.ru/video/private/caafe83ff1c6ed38d394635b83ece578/?p=IBgzQQrKH4qB1bqm_91x7Q"}`

Twenty muxed HLS formats, no separate audio. Some Rutube videos are blocked by region or network and return `403`-style failures.

_Trimmed for readability: showing 2 of 20 formats. Long URLs are cut with `...`. Full trimmed file: [`examples/rutube.json`](examples/rutube.json)._

```json
{
  "success": true,
  "platform": "rutube",
  "mediaType": "video",
  "mediaId": "caafe83ff1c6ed38d394635b83ece578",
  "canonicalUrl": "https://rutube.ru/video/private/caafe83ff1c6ed38d394635b83ece578?p=IBgzQQrKH4qB1bqm_91x7Q",
  "title": "Провал с покупкой объектива Вега-3",
  "description": "00:00 Вступление\n00:33 Что не так\n02:02 Что делать?\n02:10 Как должно быть - Scopar\n02:40 Как работает диафрагма и шкала ГРИП\n03:26 Ещё пр...",
  "author": {"name": "Borislavo"},
  "thumbnail": "https://pic.rtbcdn.ru/video/36/93/3693afc41f9f026a19bd933d3b536246.jpg",
  "durationSeconds": 287,
  "uploadDate": "20221121",
  "formats": [
    {"formatId": "default-567-0", "ext": "mp4", "kind": "video", "quality": "432x232", "width": 432, "height": 232, "fps": 59.94, "bitrate": 567, "codec": "avc1.42c01f", "filesizeApprox": false, "url": "https://river-4-411.rtbcdn.ru/hls-vod/tVYoHo-MxingiDTe_Bzcrg/1790881825/3304/0x5000c500e9cfbcd5/...", "requiresMerge": false, "compatible": true},
    {"formatId": "m3u8-8205-1", "ext": "mp4", "kind": "video", "quality": "1920x1080", "width": 1920, "height": 1080, "fps": 59.94, "bitrate": 8205, "codec": "avc1.640029", "filesizeApprox": false, "url": "https://river-1.rutube.ru/hls-vod/ou22qbh-omckPQbYxgruew/1790881825/2470/0x5000c500e8774eb8/8096...", "requiresMerge": false, "compatible": true}
  ],
  "audioFormats": [],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/rutube/caafe83ff1c6ed38d394635b83ece578",
    "sourceUrl": "https://rutube.ru/video/private/caafe83ff1c6ed38d394635b83ece578/?p=IBgzQQrKH4qB1bqm_91x7Q",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:10:27.147Z",
    "lastFetchedAt": "2026-09-24T19:10:27.147Z",
    "validatedAt": "2026-09-24T19:10:27.147Z",
    "nextCheckAt": "2026-10-01T19:10:27.147Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### SoundCloud (single track)

`POST /api/v1/fetch` with `{"url": "https://soundcloud.com/nasa/houston-we-have-a-podcast-4"}`

- Audio only: `formats` is empty and `audioFormats` lists the available tracks (HLS/HTTP MP3 and AAC). `mediaId` is SoundCloud's numeric track id.
- Profile and browse pages are rejected with `INVALID_URL`. DRM-protected (Go+) tracks return `FORMAT_UNAVAILABLE`.

_Trimmed for readability: showing 1 of 3 audio formats. Long URLs are cut with `...`. Full trimmed file: [`examples/soundcloud.json`](examples/soundcloud.json)._

```json
{
  "success": true,
  "platform": "soundcloud",
  "mediaType": "video",
  "mediaId": "2403099432",
  "canonicalUrl": "https://soundcloud.com/nasa/houston-we-have-a-podcast-4",
  "title": "Houston We Have a Podcast: Cosmic Perspectives",
  "description": "On episode 437, NASA astronaut Chris Williams and astrophysicist Neil deGrasse Tyson explore human spaceflight, astrophysics, and the won...",
  "author": {"name": "NASA", "url": "https://soundcloud.com/nasa"},
  "thumbnail": "https://i1.sndcdn.com/artworks-LTfuEDzJrFK1p4Qo-PEsQhA-original.jpg",
  "durationSeconds": 3211.642,
  "uploadDate": "20260918",
  "formats": [],
  "audioFormats": [
    {"formatId": "hls_mp3_1_0", "ext": "mp3", "bitrate": 128, "codec": "mp3", "quality": null, "filesizeBytes": 51386272, "filesizeApprox": true, "isConverted": false, "url": "https://cf-hls-media.sndcdn.com/playlist/RYIhjySuLlIK.128.mp3/playlist.m3u8?Policy=eyJTdGF0ZW1lb..."}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/soundcloud/2403099432",
    "sourceUrl": "https://soundcloud.com/nasa/houston-we-have-a-podcast-4",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:10:34.530Z",
    "lastFetchedAt": "2026-09-24T19:10:34.530Z",
    "validatedAt": "2026-09-24T19:10:34.530Z",
    "nextCheckAt": "2026-10-01T19:10:34.530Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### SoundCloud through `POST /api/v1/fetch/audio`

`POST /api/v1/fetch/audio` with `{"url": "https://soundcloud.com/nasa/houston-we-have-a-podcast-4"}`

`/fetch/audio` returns just the audio options for any platform. Here the track already has real audio formats, so `requiresConversion` is `false`. For video-only sources it instead offers one `mp3-from-<formatId>` option that is converted with ffmpeg (`isConverted: true`).

_Trimmed for readability: showing 1 of 3 audio formats. Long URLs are cut with `...`. Full trimmed file: [`examples/soundcloud-audio.json`](examples/soundcloud-audio.json)._

```json
{
  "success": true,
  "platform": "soundcloud",
  "mediaId": "2403099432",
  "canonicalUrl": "https://soundcloud.com/nasa/houston-we-have-a-podcast-4",
  "title": "Houston We Have a Podcast: Cosmic Perspectives",
  "durationSeconds": 3211.642,
  "audioFormats": [
    {"formatId": "hls_mp3_1_0", "ext": "mp3", "bitrate": 128, "codec": "mp3", "quality": null, "filesizeBytes": 51386272, "filesizeApprox": true, "isConverted": false, "url": "https://cf-hls-media.sndcdn.com/playlist/RYIhjySuLlIK.128.mp3/playlist.m3u8?Policy=eyJTdGF0ZW1lb..."}
  ],
  "requiresConversion": false
}
```

### Snapchat (Spotlight)

`POST /api/v1/fetch` with `{"url": "https://www.snapchat.com/p/8af53eee-e298-40c4-9d6e-af20cf881b61/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYYnlvaXl5amp6AZ1H3xfEAZ1H2YQIAAAAAQ"}`

One MP4 format with no resolution or codec details (`quality` and `codec` are `null`), no audio list. Snapchat is served by yt-dlp's generic HTML5 extractor.

```json
{
  "success": true,
  "platform": "snapchat",
  "mediaType": "video",
  "mediaId": "W7_EDlXWTBiXAEEniNoMPwAAYYnlvaXl5amp6AZ1H3xfEAZ1H2YQIAAAAAQ-1",
  "canonicalUrl": "https://www.snapchat.com/p/8af53eee-e298-40c4-9d6e-af20cf881b61/spotlight/W7_EDlXWTBiXAEEniNoMPw...",
  "title": "3.1 ہزار لائیکس، 1.0 ہزار تبصرے، اور 3.0 ہزار شیئرز | introducing reals  | Team Snapchat | 1 اپریل، 2026 کو پوسٹ کردہ | Spotlight (1)",
  "description": "A man in a black t-shirt speaks directly to the camera in front of a wooden bookshelf, announcing a significant change for Snapchat. He e...",
  "author": {},
  "thumbnail": "https://cf-st.sc-cdn.net/d/rNe7IEIM72elKXhSclqCu.256.IRZXSOY?mo=GkYaCTIBBEgCUC5gAVCgAVoQRGZMYXJn...",
  "durationSeconds": null,
  "formats": [
    {"formatId": "0", "ext": "mp4", "kind": "video", "quality": null, "width": null, "height": null, "bitrate": null, "codec": null, "filesizeBytes": null, "filesizeApprox": false, "url": "https://cf-st.sc-cdn.net/d/rNe7IEIM72elKXhSclqCu.27.IRZXSOY?mo=GmAaCTIBBEgCUC5gAVCiAVoQU3BvdGxpZ...", "requiresMerge": false, "compatible": false}
  ],
  "audioFormats": [],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/snapchat/W7_EDlXWTBiXAEEniNoMPwAAYYnlvaXl5amp6AZ1H3xfEAZ1H2YQIAAAAAQ-1",
    "sourceUrl": "https://www.snapchat.com/p/8af53eee-e298-40c4-9d6e-af20cf881b61/spotlight/W7_EDlXWTBiXAEEniNoMPw...",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:10:45.954Z",
    "lastFetchedAt": "2026-09-24T19:10:45.954Z",
    "validatedAt": "2026-09-24T19:10:45.954Z",
    "nextCheckAt": "2026-10-01T19:10:45.954Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Twitch (VOD)

`POST /api/v1/fetch` with `{"url": "https://www.twitch.tv/videos/2702797838"}`

VODs, including 50+ minute recordings: five muxed HLS qualities (160p up to 1080p60) and an `Audio_Only` track. `durationSeconds` is in seconds (3008 here).

_Trimmed for readability: showing 2 of 5 formats. Long URLs are cut with `...`. Full trimmed file: [`examples/twitch.json`](examples/twitch.json)._

```json
{
  "success": true,
  "platform": "twitch",
  "mediaType": "video",
  "mediaId": "v2702797838",
  "canonicalUrl": "https://www.twitch.tv/videos/2702797838",
  "title": "RatSpiderFrog [Steam Next Fest 2026 - Key Provided]",
  "description": "We playthrough the Demo of RatSpiderFrog that was provided by the developers who also gave us the keys for the giveaway! This game will b...",
  "author": {"name": "Manaricelle"},
  "thumbnail": "https://static-cdn.jtvnw.net/cf_vods/d1m7jfoe9zdc1j/20f1f1029224a57f7708_manaricelle_23530583983...",
  "durationSeconds": 3008,
  "uploadDate": "20260220",
  "formats": [
    {"formatId": "160p", "ext": "mp4", "kind": "video", "quality": "284x160", "width": 284, "height": 160, "fps": 30, "bitrate": 291.297, "codec": "avc1.4D400C", "filesizeApprox": false, "url": "https://d1m7jfoe9zdc1j.cloudfront.net/20f1f1029224a57f7708_manaricelle_23530583983_6939317647/16...", "requiresMerge": false, "compatible": true},
    {"formatId": "1080p60", "ext": "mp4", "kind": "video", "quality": "Source", "width": 1920, "height": 1080, "fps": 60, "bitrate": 5367.945, "codec": "avc1.64002A", "filesizeApprox": false, "url": "https://d1m7jfoe9zdc1j.cloudfront.net/20f1f1029224a57f7708_manaricelle_23530583983_6939317647/ch...", "requiresMerge": false, "compatible": true}
  ],
  "audioFormats": [
    {"formatId": "Audio_Only", "ext": "mp4", "bitrate": 209.541, "codec": "mp4a.40.2", "filesizeApprox": false, "isConverted": false, "url": "https://d1m7jfoe9zdc1j.cloudfront.net/20f1f1029224a57f7708_manaricelle_23530583983_6939317647/au..."}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/twitch/v2702797838",
    "sourceUrl": "https://www.twitch.tv/videos/2702797838",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:10:52.509Z",
    "lastFetchedAt": "2026-09-24T19:10:52.509Z",
    "validatedAt": "2026-09-24T19:10:52.509Z",
    "nextCheckAt": "2026-10-01T19:10:52.509Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Pinterest (video pin)

`POST /api/v1/fetch` with `{"url": "https://www.pinterest.com/pin/424605071136961057/"}`

A video pin: video-only and muxed formats plus an audio track. `pin.it` short links are accepted and resolved to the pin.

_Trimmed for readability: showing 2 of 10 formats. Long URLs are cut with `...`. Full trimmed file: [`examples/pinterest.json`](examples/pinterest.json)._

```json
{
  "success": true,
  "platform": "pinterest",
  "mediaType": "video",
  "mediaId": "424605071136961057",
  "canonicalUrl": "https://www.pinterest.com/pin/424605071136961057/",
  "title": "The journey to a more inclusive Pinterest starts here. 📌",
  "description": "Your favorite plus-size fashion tastemakers helped Pinterest develop new tech that champions diversity. Now you'll see more body shapes, ...",
  "author": {"name": "Pinterest"},
  "thumbnail": "https://i.pinimg.com/originals/dc/59/c7/dc59c78056607f0250deb7611d387731.jpg",
  "durationSeconds": 43.333,
  "uploadDate": "20230907",
  "formats": [
    {"formatId": "V_HLSV3_MOBILE-426", "ext": "mp4", "kind": "video_only", "quality": "234x416", "width": 234, "height": 416, "fps": 30, "bitrate": 426.81, "codec": "avc1.4d400d", "filesizeApprox": false, "url": "https://v1.pinimg.com/videos/mc/hls/91/ee/22/91ee22f657cd9bf8979623646d9b26fb_240w.m3u8", "requiresMerge": true, "compatible": true},
    {"formatId": "V_EXP7", "ext": "mp4", "kind": "video", "quality": "1080x1920", "width": 1080, "height": 1920, "bitrate": null, "filesizeBytes": null, "filesizeApprox": false, "url": "https://v1.pinimg.com/videos/mc/720p/91/ee/22/91ee22f657cd9bf8979623646d9b26fb.mp4", "requiresMerge": false, "compatible": false}
  ],
  "audioFormats": [
    {"formatId": "V_HLSV3_MOBILE-program_audio_0-Alternate_Audio", "ext": "mp4", "bitrate": null, "quality": "Alternate Audio", "filesizeApprox": false, "isConverted": false, "url": "https://v1.pinimg.com/videos/mc/hls/91/ee/22/91ee22f657cd9bf8979623646d9b26fb_audio.m3u8"}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/pinterest/424605071136961057",
    "sourceUrl": "https://www.pinterest.com/pin/424605071136961057/",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:12:21.249Z",
    "lastFetchedAt": "2026-09-24T19:12:21.249Z",
    "validatedAt": "2026-09-24T19:12:21.249Z",
    "nextCheckAt": "2026-10-01T19:12:21.249Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Pinterest (board)

`POST /api/v1/fetch` with `{"url": "https://www.pinterest.com/pinterest/official-news/", "rangeStart": 1, "rangeEnd": 20}`

A board is returned as a collection: `mediaType: "carousel"` with one entry per pin in `items`, each with its own `formats` (`type: "video"`) or `source` (`type: "image"`). Use `rangeStart` / `rangeEnd` in the request to page through big boards (`metadata.truncated` tells you more exists). Ranged requests are never stored.

_Trimmed for readability: showing 2 of 51 items. Long URLs are cut with `...`. Full trimmed file: [`examples/pinterest-board.json`](examples/pinterest-board.json)._

```json
{
  "success": true,
  "platform": "pinterest",
  "mediaType": "carousel",
  "mediaId": "424605139806979476",
  "canonicalUrl": "https://www.pinterest.com/pinterest/official-news",
  "title": "Official news",
  "thumbnail": "https://i.pinimg.com/upload/424605139806979476_board_thumbnail_2023-09-07-16-01-40_997_60.jpg",
  "isCarousel": true,
  "itemCount": 51,
  "items": [
    {"id": "424605071112831904", "type": "image", "thumbnail": "https://i.pinimg.com/originals/32/68/65/3268658fe7973644e6e6e5be15266517.jpg", "source": "https://i.pinimg.com/originals/32/68/65/3268658fe7973644e6e6e5be15266517.jpg"},
    {"id": "424605071093691246", "type": "image", "thumbnail": "https://i.pinimg.com/originals/ae/cb/6f/aecb6f2fa70649bc9625e061b1f53ed2.jpg", "source": "https://i.pinimg.com/originals/ae/cb/6f/aecb6f2fa70649bc9625e061b1f53ed2.jpg"}
  ],
  "formats": [],
  "audioFormats": [],
  "metadata": {"truncated": true, "maxItemsPerRequest": 200, "totalPinCount": 51, "rangeStart": 1, "rangeEnd": 51},
  "extractor": "pinterest-board-api",
  "fallbackUsed": "pinterest-board-api",
  "stored": {
    "path": "/pinterest/424605139806979476",
    "sourceUrl": "https://www.pinterest.com/pinterest/official-news/",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:11:04.171Z",
    "lastFetchedAt": "2026-09-24T19:11:04.171Z",
    "validatedAt": "2026-09-24T19:11:04.171Z",
    "nextCheckAt": "2026-10-01T19:11:04.171Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Loom

`POST /api/v1/fetch` with `{"url": "https://www.loom.com/share/9245fa69349d4dfa8a8ade8b728ce1f6"}`

HLS video-only formats (merge required) plus a separate audio track. ffmpeg cannot read Loom's signed playlists, so `GET /stream?mode=stream` reports it cannot stream this source; use `mode=auto` (recommended) or `mode=prepare`, which fall back to the server-side download path.

```json
{
  "success": true,
  "platform": "loom",
  "mediaType": "video",
  "mediaId": "9245fa69349d4dfa8a8ade8b728ce1f6",
  "canonicalUrl": "https://www.loom.com/share/9245fa69349d4dfa8a8ade8b728ce1f6",
  "title": "How to Upload a Downloadable Product on AFOMA Marketplace",
  "description": "In this video, I walk you through the process of uploading a Downloadable product on our AFOMA Marketplace. Downloadable products are dig...",
  "author": {"name": "AFOMA Marketplace"},
  "durationSeconds": 386,
  "uploadDate": "20250316",
  "formats": [
    {"formatId": "hls-raw-1500", "ext": "mp4", "kind": "video_only", "quality": "1260x720", "width": 1260, "height": 720, "fps": null, "bitrate": 1500, "filesizeApprox": false, "url": "https://luna.loom.com/id/9245fa69349d4dfa8a8ade8b728ce1f6/rev/83c6758ef75a3f8c57d8e1a5ce037c0fa5...", "requiresMerge": true, "compatible": false},
    {"formatId": "hls-raw-3200", "ext": "mp4", "kind": "video_only", "quality": "1890x1080", "width": 1890, "height": 1080, "fps": null, "bitrate": 3200, "filesizeApprox": false, "url": "https://luna.loom.com/id/9245fa69349d4dfa8a8ade8b728ce1f6/rev/83c6758ef75a3f8c57d8e1a5ce037c0fa5...", "requiresMerge": true, "compatible": false}
  ],
  "audioFormats": [
    {"formatId": "hls-raw-audio-audio", "ext": "mp4", "bitrate": null, "quality": "audio", "filesizeApprox": false, "isConverted": false, "url": "https://luna.loom.com/id/9245fa69349d4dfa8a8ade8b728ce1f6/rev/83c6758ef75a3f8c57d8e1a5ce037c0fa5..."}
  ],
  "metadata": {"isLive": false},
  "extractor": "yt-dlp",
  "stored": {
    "path": "/loom/9245fa69349d4dfa8a8ade8b728ce1f6",
    "sourceUrl": "https://www.loom.com/share/9245fa69349d4dfa8a8ade8b728ce1f6",
    "status": "available",
    "cached": false,
    "urlsStale": false,
    "firstFetchedAt": "2026-09-24T19:11:10.798Z",
    "lastFetchedAt": "2026-09-24T19:11:10.798Z",
    "validatedAt": "2026-09-24T19:11:10.798Z",
    "nextCheckAt": "2026-10-01T19:11:10.798Z",
    "stats": {"fetchCount": 1, "hitCount": 0, "viewCount": 0, "downloadCount": 0, "streamCount": 0, "prepareCount": 0, "bytesServed": 0, "lastAccessedAt": null, "lastDownloadedAt": null}
  }
}
```

### Newgrounds

`POST /api/v1/fetch` with `{"url": "https://www.newgrounds.com/portal/view/921925"}`

Public movies with a video return the same shape as the other yt-dlp video responses (muxed MP4 formats, no merge), and movies without a video return `MEDIA_NOT_FOUND`. Newgrounds sits behind bot protection that blocks some server IPs; when it does, the request fails as below. (A success response could not be captured at the time this page was written because the capture machine was blocked, so none is shown here rather than an invented one.)

```json
{
  "success": false,
  "error": {
    "code": "PLATFORM_RATE_LIMITED",
    "message": "The source platform is rate-limiting requests."
  },
  "requestId": "d011f9d8-3713-42a6-a915-3cd581c9240d"
}
```

### Tumblr

Tumblr is wired (`tumblr.com` posts go through yt-dlp) but has not been verified against a live post yet, so no
response is shown. Expect the same shape as the other yt-dlp video responses.

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

Cancels the job (terminating any in-flight yt-dlp/ffmpeg process, including anything they
spawned) and removes its temp directory. The job ends as `cancelled`.

### Temp file cleanup (prepare mode)

Files created by `POST /download` are removed as soon as the job is downloaded, fails, is cancelled,
or expires. A file that was never downloaded is deleted by a periodic sweep: anything in `TEMP_DIR`
older than `TEMP_SWEEP_MAX_AGE_MS` (default 1 hour) is removed every `TEMP_SWEEP_INTERVAL_MS`
(default 10 minutes). If a client drops mid-download the file is kept so a retry works, and the
sweep removes it later. Requesting a download whose file has been swept returns `404 JOB_NOT_FOUND`
and marks the job `expired`.

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

## `GET /api/v1/stream` (direct stream, prepare, or auto)

One URL with three delivery modes, chosen per request with `?mode=` (or server-wide with
`DEFAULT_DOWNLOAD_MODE`). It is a plain `GET`, so a browser can start the download simply by
navigating to the URL (the guest cookie is sent automatically). There is **no job and no polling**:
the file comes back in this one response.

```
GET /api/v1/stream?url=<source url>&formatId=<id|best>&kind=video|audio&filename=<optional>&mode=stream|prepare|auto
```

| Query param | Required | Description |
|---|---|---|
| `url` | yes | Any URL from a supported platform (URL-encode it) |
| `formatId` | no (default `best`) | A `formatId` from `/fetch` or `/fetch/audio`, or `best` for the highest quality |
| `kind` | no (default `video`) | `video` or `audio` |
| `filename` | no | Suggested file name; the correct extension is added if missing |
| `token` | no | 8 to 64 characters (`A-Z a-z 0-9 _ -`) chosen by your page. When bytes start flowing the response sets the cookie `blazfetch_dl_<token>=1` (60 s), so a page that starts the download by navigation (an `<a>` or hidden `<iframe>`) can detect that it really began |
| `mode` | no (default `DEFAULT_DOWNLOAD_MODE`, which is `stream`) | `stream`, `prepare` or `auto` (below) |

### Delivery modes

| Mode | What happens | Best for |
|---|---|---|
| `stream` (default) | Bytes are piped from the source straight to the response. No file on the server, first byte in 1 to 3 s. Original codecs are kept (no transcode). | Speed |
| `prepare` | The server builds the file first (download, merge, and a transcode to H.264/AAC when the source is not browser-compatible), then sends it with its exact size, then deletes it. All in this one request, so nothing arrives until it is ready. | Guaranteed H.264/AAC, or sources that cannot stream |
| `auto` | Tries `stream`. If that fails **before the first byte**, the server switches to `prepare` **in the same request**, so the client still just gets the file. | Recommended for the frontend: fast when possible, works when not |

`auto` falls back only for failures that preparing can get around (the source could not be
streamed, ffmpeg or extraction failed, a timeout). It does **not** fall back for errors that would
fail the same way, such as `PRIVATE_MEDIA`, `LOGIN_REQUIRED`, `AGE_RESTRICTED`, `MEDIA_NOT_FOUND`,
DRM-protected media, or `SERVER_BUSY`; those come straight back as JSON.

Two limits to be aware of:
- A failure **after** the first byte cannot fall back, because bytes have already been sent. The
  connection is aborted, so treat a connection that ends early as a failed download.
- While a fallback is being prepared, the client receives nothing until the file is ready (it can
  take a minute or more for long videos). If you need a progress bar for that, use `POST /download`
  and poll `/jobs/:id`.

Every successful response includes **`X-Blazfetch-Mode: stream | prepare`** telling you which path
served the file (exposed to browsers through CORS), so you can see how often `auto` falls back.

**Success `200`:** `Content-Disposition: attachment`, the right `Content-Type`, and chunked transfer
(no `Content-Length`) in stream mode unless the exact size is known; prepare mode always sends
`Content-Length`.

**Errors before the first byte** come back as the normal JSON envelope with the usual codes and
HTTP status (`success:false`, `error:{code,message}`, `requestId`).

### How the bytes are produced

| Requested format | Pipeline |
|---|---|
| Plain single file (most muxed formats, standalone audio) | the file's bytes are passed through untouched (exact size, original container) |
| Video-only format needing audio (e.g. YouTube 1080p+) | video + best AAC audio are merged by ffmpeg with `-c copy` into **fragmented MP4** (`-movflags frag_keyframe+empty_moov+default_base_moof`), because a normal MP4 cannot be written to a pipe |
| HLS video | ffmpeg remux (`-c copy`, ADTS AAC converted) to fragmented MP4 |
| MP3 (no standalone audio track) | `ffmpeg -vn -c:a libmp3lame -f mp3` |

- **No H.264 transcode in stream mode.** Codecs are copied as-is (for example VP9 or AV1 + AAC in
  MP4), which is what makes it fast. Modern browsers and players handle this, but if you need
  guaranteed H.264/AAC output use `POST /download` (prepare mode), which transcodes when needed.
- **Sources that cannot stream:** some sources cannot be streamed directly (Loom's signed HLS playlists
  are one, because ffmpeg cannot read them). With `mode=stream` they return a JSON error
  (`DOWNLOAD_FAILED`); with `mode=auto` they are served by prepare mode automatically.
- For the quickest start call `POST /fetch` first: the stream reuses the URLs it resolved, so the
  first byte typically arrives in 1 to 3 seconds. Without a prior fetch it has to resolve the media
  first, which can add several seconds on sites like YouTube.

### Limits and safety

- Uses the same concurrency limits as jobs (`MAX_CONCURRENT_DOWNLOADS_GLOBAL`, per user/guest) and the
  download rate limiter (`RATE_LIMIT_MAX_DOWNLOAD`); over the limit returns `SERVER_BUSY`.
- Aborts at `MAX_DOWNLOAD_SIZE_BYTES` and at `DOWNLOAD_TOTAL_TIMEOUT_MS`.
- If the client disconnects, every yt-dlp/ffmpeg process behind the stream is killed immediately and
  the download slot is released.
- URLs go through the same validation and SSRF checks as every other endpoint.
- Every stream (finished, failed or disconnected) is recorded with `recordDownloadStat`.
- Disable the endpoint (all three modes) with `STREAM_MODE_ENABLED=false`; the route then returns
  `404 NOT_FOUND`. `POST /download` and the rest are unaffected. Change the default mode with
  `DEFAULT_DOWNLOAD_MODE=stream|prepare|auto` (an explicit `?mode=` always wins).

---

## YouTube blocks and the fallback provider

When YouTube sees many requests from one IP it temporarily answers yt-dlp with "Sign in to confirm
you're not a bot". Instead of failing, the backend then:

1. **Serves the request with a fallback provider** (btch-downloader), which still works from a blocked
   IP. The response has `extractor: "btch-downloader"` and `fallbackUsed: "btch-downloader"`, one
   video format (`btch-mp4`, 360p to 720p MP4) and one audio format (`btch-m4a`, AAC in MP4). Fetch,
   `GET /stream` (all modes) and `POST /download` all work.
2. **Backs off for `YOUTUBE_BLOCK_COOLDOWN_SECONDS` (default 10 minutes):** yt-dlp is skipped for
   YouTube and the fallback is used directly, so the server stops hitting YouTube and the block is not
   extended. yt-dlp is tried again automatically afterwards.

The fallback is used only for failures it can plausibly fix (the bot check, other sign-in requirements,
timeouts, extractor errors). It is **not** used for deleted, private, region-locked or age-restricted
videos, so "gone" answers (and the weekly availability check) stay accurate. If the fallback fails too,
the original error is returned. Turn it off with `YOUTUBE_FALLBACK_ENABLED=false`.

Notes:
- The provider's links die within about a minute, so answers that came from it are trusted for
  `FALLBACK_LINK_TTL_SECONDS` (30) only, and a stream re-extracts a fresh link (and retries once if a
  link is refused).
- Quality is whatever the provider offers (usually up to 720p), not the full range yt-dlp finds.
- For the best long-term reliability on a busy server, also reduce the load on YouTube: keep the media
  store on (repeat requests never touch YouTube) and consider a proxy or residential IP if blocks are frequent.

---

## Stored media and stable paths

Everything `POST /fetch` extracts is **kept in the database forever** (metadata only, never the media
files): the complete response, the platform, the original URL you gave, the title, author, duration,
formats, and usage statistics. The next request for the same media is answered from the database in
milliseconds instead of re-extracting it (which can take 3 to 15 seconds).

### The `stored` block

Every `/fetch` (and `/media`) response carries a `stored` object:

```json
"stored": {
  "path": "/youtube/Cwkej79U3ek",
  "playlistPath": "/youtube/Cwkej79U3ek/playlist/RDCwkej79U3ek",
  "sourceUrl": "https://www.youtube.com/watch?v=Cwkej79U3ek&list=RDCwkej79U3ek",
  "status": "available",
  "cached": true,
  "urlsStale": false,
  "firstFetchedAt": "2026-09-24T14:21:00.000Z",
  "lastFetchedAt": "2026-09-24T14:21:00.000Z",
  "validatedAt": "2026-09-24T14:21:00.000Z",
  "nextCheckAt": "2026-10-01T14:21:00.000Z",
  "stats": { "fetchCount": 1, "hitCount": 4, "viewCount": 2, "downloadCount": 1, "streamCount": 1,
             "prepareCount": 0, "bytesServed": 5485612, "lastAccessedAt": "...", "lastDownloadedAt": "..." }
}
```

| Field | Meaning |
|---|---|
| `path` | Stable path for this media. Use it for your own page URL, e.g. `website.com/youtube/Cwkej79U3ek` |
| `playlistPath` | Only when the URL had both `v=` and `list=`: the playlist in that video's context |
| `cached` | `true` when this answer came from the database, `false` when it was just extracted |
| `urlsStale` | The direct media URLs inside `formats` are older than `CACHE_TTL_SECONDS`; they refresh in the background |
| `validationFailed` | A live existence check failed without proving the media gone, so the last known answer is served |
| `validatedAt` / `nextCheckAt` | Last time the media was confirmed to exist, and when the next check is due |
| `stats` | Per-media usage counters (below) |

Paths are `/<platform>/<id>` for an item and `/<platform>/<id>/playlist/<listId>` (or
`/<platform>/playlist/<listId>`) for a playlist. Ids are the platform's own (YouTube video id, TikTok
video id, Instagram shortcode, ...). YouTube `list=RD...` Mixes are generated per viewer, so they are
refreshed hourly instead of daily.

### `GET /api/v1/media/<platform>/<id>` (serve by stable path)

```
GET /api/v1/media/youtube/Cwkej79U3ek
GET /api/v1/media/youtube/Cwkej79U3ek/playlist/RDCwkej79U3ek
GET /api/v1/media/youtube/playlist/PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI
```

Returns the same response as `/fetch` (including `stored`). It is what a frontend page at
`website.com/youtube/Cwkej79U3ek` calls.

- **Stored:** answered from the database and counted as a view.
- **Never fetched:** if the link can be rebuilt from the id alone (YouTube, Vimeo, Dailymotion, Twitch,
  Streamable, Loom, Newgrounds, Pinterest, Rutube, Instagram, X/Twitter, TikTok, Facebook, Snapchat,
  SoundCloud) it is fetched and stored now. For platforms that need more than the id (Bluesky needs the
  handle, Reddit the subreddit, Tumblr the blog) it answers `404 MEDIA_NOT_FOUND`; call `POST /fetch`
  with the original URL first.
- `?cacheOnly=true` never contacts the source: not stored means `404 MEDIA_NOT_FOUND`.
- Anything extracted with the operator's own login (`INSTAGRAM_COOKIES_PATH`) is never served by path.
- Uses the fetch rate limiter.

### Weekly revalidation and unavailable media

Every stored item is re-checked **every 7 days** (`REVALIDATE_AFTER_SECONDS`) to see whether it still
exists, in two ways:

1. **On demand:** when a user requests an item whose check is due, it is re-extracted first, so the answer
   is accurate. A deleted video is noticed the moment someone asks for it.
2. **In the background:** a job (`REVALIDATE_INTERVAL_MS`, default every 30 minutes) checks due items
   oldest first, one at a time with a pause between checks (`REVALIDATE_DELAY_MS`), so nothing is
   hammered. It also notices items nobody has asked for.

What a check finds:

| Result | What happens |
|---|---|
| Still there | Stored answer refreshed, next check in 7 days |
| "Not found" or "private" once | Not enough to conclude: the stored answer is still served (`validationFailed: true`), retried the next day |
| "Not found" or "private" twice in a row (`UNAVAILABLE_AFTER_FAILURES`) | Marked **unavailable**. Requests answer `410 MEDIA_UNAVAILABLE` with a tombstone (below) |
| Timeout, rate limit, extractor error | Says nothing about existence: never counted, retried after `TRANSIENT_RETRY_SECONDS` (1 hour) |
| An unavailable item is found again | Marked available again automatically |

A known-unavailable item is not re-extracted on every request: it is looked at again at most every
`UNAVAILABLE_RECHECK_SECONDS` (10 minutes) and otherwise answered from the tombstone. Stored data is
never deleted, so the tombstone can still show what the media was:

```json
{
  "success": false,
  "error": {
    "code": "MEDIA_UNAVAILABLE",
    "message": "This media is no longer available at the source.",
    "details": { "tombstone": { "platform": "youtube", "path": "/youtube/Cwkej79U3ek", "title": "...", "thumbnail": "...",
                                "reason": "MEDIA_NOT_FOUND", "unavailableSince": "...", "lastSeenAvailable": "...", "sourceUrl": "..." } }
  },
  "requestId": "..."
}
```

### Statistics that are stored

**Per media** (on the stored row, shown in `stored.stats`): `fetchCount` (live extractions), `hitCount`
(answered from the database), `viewCount` (reads through `/media`), `downloadCount`, `streamCount`,
`prepareCount`, `bytesServed`, `lastAccessedAt`, `lastDownloadedAt`, plus `firstFetchedAt`,
`validatedAt` and `unavailableSince`.

**Per event** (one row each, for analysis): every fetch records whether it was a cache hit, whether the
stored URLs were stale, the kind (video/playlist), whether it came from a user or the weekly check,
duration and error code. Every download records the delivery mode (`stream` or `prepare`), time to first
byte, whether `auto` mode fell back, format, quality, bytes, duration and error code, all tied to the
media, the platform and the (guest) user.

---

## Cloudflare Turnstile (optional bot check)

Turnstile is Cloudflare's free, privacy-friendly CAPTCHA replacement. It is **off by default**. When
`TURNSTILE_ENABLED=true`, `POST /fetch`, `POST /fetch/audio`, `GET /media/...`, `GET /stream` and `POST /download` need a passed check.
The media route can extract missing or stale metadata, so it uses the same gate as fetch. Public configuration,
aggregate statistics, the platform list and health endpoints remain open. Existing job delivery checks job ownership.

How it works:

1. `GET /api/v1/config` returns `{ "turnstile": { "enabled": true, "siteKey": "...", "sessionSeconds": 1800 } }`. The
   site key is public; the secret key never leaves the server.
2. The frontend renders the Cloudflare widget with that site key and gets a one-time token.
3. `POST /api/v1/turnstile/verify` with `{ "token": "..." }`. The server validates it with Cloudflare
   (`POST https://challenges.cloudflare.com/turnstile/v0/siteverify`; tokens are single use and expire after 5 minutes) and
   answers with a signed **pass cookie** (`blazfetch_turnstile`, HttpOnly, bound to the visitor's guest cookie) valid for
   `TURNSTILE_SESSION_SECONDS` (default 30 minutes).
4. Protected endpoints check that cookie. A cookie is used rather than a header so plain browser navigations such as
   `GET /stream` also work. Without a valid pass they answer `403 TURNSTILE_REQUIRED`; the client should run the widget
   again and retry.

| Endpoint | Purpose |
|---|---|
| `GET /config` | Public settings: whether Turnstile is on, and the site key |
| `POST /turnstile/verify` | Swap a solved widget token for the pass cookie. `403 TURNSTILE_FAILED` when Cloudflare rejects the token or cannot be reached (it fails closed) |

A client should call `/turnstile/verify` lazily, when the visitor first does something protected, rather than on page load. Send `credentials: 'include'` so the cookies travel. Set up: [docs/REQUIREMENTS.md](REQUIREMENTS.md#cloudflare-turnstile-optional).

`TURNSTILE_ALLOWED_HOSTNAMES` optionally checks Siteverify's hostname against a comma-separated list (no scheme or port).
`TURNSTILE_EXPECTED_ACTION` optionally checks its action; `/config` supplies that action to the frontend widget.
The pass cookie is an application session, not a reusable Cloudflare token or a Cloudflare `cf_clearance` cookie.
Cloudflare tokens are submitted once; expired or refused passes require a new widget token.

Statistics describe completed API transfers, including an audio transfer used for preview. Saving that cached audio
again or downloading an image directly from an external CDN makes no new API transfer and adds no server count.
Historic statistics are preserved; old rows that did not distinguish internal work cannot be reliably reclassified.

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
  "checks": { "database": true, "ytdlp": true, "ffmpeg": true }
}
```

The response is public, so it holds only pass/fail flags: versions and the database type are left out (`npm run diagnostics` on the server shows them).

Returns `503` with `success: false` if any dependency check fails — suitable as a load balancer
or orchestrator readiness probe:

```json
{
  "success": false,
  "status": "not_ready",
  "checks": {
    "database": true,
    "ytdlp": true,
    "ffmpeg": false
  }
}
```

---

## Quick reference for frontend integration

> [!TIP]
> The official frontend, [blazfetch-web](https://github.com/ssanaullahrais/blazfetch-web), already
> implements everything below. Its [integration guide](https://github.com/ssanaullahrais/blazfetch-web/blob/main/docs/INTEGRATION.md) maps each screen to these endpoints.

**Simplest flow (recommended):** the user pastes a URL.

1. `POST /fetch` with the URL. You get the title, thumbnail, `formats[]`/`audioFormats[]` (or `items[]`
   for a carousel/board, `playlist.items` for a playlist: recurse into an item's own `url` for its
   formats) and `stored.path`, the stable path to use for your own page URL (`website.com/youtube/<id>`).
2. Let the user pick a quality, or skip this and use `formatId=best`.
3. Navigate the browser to `GET /stream?url=...&formatId=best&kind=video&mode=auto`. The download
   starts immediately, in one request, with no polling. `X-Blazfetch-Mode` in the response says whether
   it was streamed or prepared.
4. Send `credentials: 'include'` on every request so the guest cookie (rate limits, concurrency) works, and
   list your frontend in `CORS_ALLOWED_ORIGINS` (never `*` with cookies).

**Pretty pages:** a page at `website.com/<platform>/<id>` calls `GET /media/<platform>/<id>`. It answers
from the database, fetches never-seen media when the link can be rebuilt from the id, and answers
`410 MEDIA_UNAVAILABLE` with a tombstone when the media was deleted.

**Job flow (when you want server-side progress):**

1. `POST /download` with `{ url, formatId, kind }` returns a `job.id` immediately (`202`).
2. Poll `GET /jobs/:id` every 1-2 s until `status` is `ready` or `completed` (or `failed`: show
   `errorCode`/`errorMessage`). `job.progress` (0-100) and `job.downloadedBytes`/`totalBytes` drive a
   progress bar.
3. Navigate to `GET /downloads/:id` for the file (`Content-Disposition: attachment`).

**Errors:** always the same envelope (`success:false`, `error.code`, `error.message`, `requestId`); switch on
`error.code`. Handle at least `MEDIA_NOT_FOUND`, `MEDIA_UNAVAILABLE`, `PRIVATE_MEDIA`, `AGE_RESTRICTED`,
`GEO_RESTRICTED`, `LOGIN_REQUIRED`, `FORMAT_UNAVAILABLE` (e.g. DRM), `SERVER_BUSY` and
`PLATFORM_RATE_LIMITED` with friendly messages.

---

<div align="center">
<a href="../README.md">Back to README</a> · <a href="https://github.com/ssanaullahrais/blazfetch-web">blazfetch-web</a>
</div>

## License

Free to use, modify and deploy (including on your own VPS), but not to sell, and the official frontend must keep its footer credit. See [LICENSE](../LICENSE) and [AGENTS.md](../AGENTS.md).
