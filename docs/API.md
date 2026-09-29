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

## Authentication

By default, requests use an automatic `blazfetch_guest_id` cookie for job ownership and limits; no user login is provided. With `API_AUTH_ENABLED=true`, every `/api/v1` route and `/health/ready` also requires a server-side `X-API-Key`. `/health` stays public. See [API-key setup](api-protection.md).

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
| [Playlist jobs](playlist-and-fallback.md#bulk-download-api) | `POST /playlist/download`, `GET` / `DELETE /playlist/downloads/:id` |
| `GET /stats` | Totals `{ fetches, downloads, platforms, online }`. Downloads count after completed delivery, not preparation. Successful fetch/media responses count; internal lookups and failures do not. `online` tracks recent distinct visitors (default 60s window) |
| `GET /stats/events` | SSE totals after committed writes, with cross-worker checks every 2s and a 15s heartbeat. Disable proxy buffering |
| [`GET /platforms`](#get-apiv1platforms) | Supported platforms and their domains |
| [`GET /health`, `GET /health/ready`](#get-health) | Liveness and readiness probes |

### Which download method should I use?

| You want | Use |
|---|---|
| The fastest start, one request, nothing on the server's disk | `GET /stream?mode=stream` (the default): streams everything, merges and HLS included |
| It to just work for every source, still one request | **`GET /stream?mode=auto`** (recommended): streams first, prepares only if streaming fails |
| Compatible H.264/AAC output | `GET /stream?mode=prepare` |
| A progress bar driven by the server while a long file is prepared | `POST /download`, then poll `GET /jobs/:id` |

## Platform status

Verified with real downloads against live URLs, not just metadata calls. Per-platform response examples are in [Responses by platform](#responses-by-platform). "Confirmed" means a
real video/audio file was downloaded and ffprobe-validated (correct streams, valid duration).

| Platform | Status | Notes |
|---|---|---|
| YouTube | ✅ Confirmed | Video, playlists (flat listing), best-quality auto-select. Attempts fallback when YouTube blocks the server; recovery is not guaranteed |
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
| Twitch | ✅ Samples passed | Clip and complete 50-minute VOD at 160p |
| Pinterest | ✅ Confirmed (pins + boards) | Public `PinResource`/`BoardResource` API, no auth needed — see below |
| Loom | ✅ Confirmed | Video and audio, including HLS streams |
| Newgrounds | ⚠️ Network blocked | Latest test network returned HTTP 403 |
| Tumblr | ✅ Sample passed | Public HTML5 video; generic-extractor recovery |
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
| `API_AUTH_REQUIRED` | 401 | Optional server-to-server API protection is enabled and a valid `X-API-Key` is missing |
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

**Ownership:** guest cookie (automatic). Optional API key applies to all endpoints.
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
| `fallbackUsed` | string | Identifies a recovery path, including independent providers and generic-extractor retry |
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

JSON examples are captured API responses with shortened arrays/text and redacted signed URLs. Counts refer to the full response; samples may use cached metadata. Audio examples reflect `AUDIO_FORCE_MP3=true`. The blocked-provider sample is historical, not a fresh recovery check. Stored responses include the [`stored` block](#stored-media-and-stable-paths).

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
| Tumblr | video | public HTML5 video | no (sample) | source-dependent |

`formats[].kind` is `video` (audio included), `video_only` (needs `requiresMerge`) and `audioFormats`
lists audio-only tracks. Pass `"formatId": "best"` (or omit it) when downloading to skip picking.

### YouTube

`POST /api/v1/fetch` with `{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}`

- One muxed format (`18`, 360p) plus many **video-only** formats (`requiresMerge: true`): pick one and the server pairs it with the best AAC audio automatically. `compatible: true` marks H.264 video.
- Accepts `watch`, `youtu.be`, `shorts`, `live` and `embed` URLs. `mediaId` is the 11-character video id, and the stable path is `/youtube/<id>`.
- A URL with both `v=` and `list=` returns the **video**; `stored.playlistPath` then points at the playlist in that video's context.


[Example response](examples/youtube.json).

### YouTube: the same request again (answered from the database)

`POST /api/v1/fetch` with `{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}`

Fetching something already stored is answered from the database in milliseconds. The only difference is the `stored` block: `cached: true` and updated counters (`hitCount`, `viewCount`, ...).


[Example response](examples/youtube-cached.json).

### YouTube playlist

`POST /api/v1/fetch` with `{"url": "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"}`

- `mediaType: "playlist"`. Items come from a fast flat listing (no formats per item); fetch an item's own `url` to get its formats.
- Limited to `MAX_PLAYLIST_ITEMS` (default 1000); `itemCount` is the number returned. `metadata.playlistTruncated` indicates a limit was reached (or conservatively may have been reached if the extractor supplies no total). Increase the limit and force-refresh cached listings to include more. The frontend reveals rows automatically on scroll; this does not bypass the backend limit. Stable path: `/youtube/playlist/<listId>`.


[Example response](examples/youtube-playlist.json).

### YouTube when YouTube blocks the server (fallback provider)

`POST /api/v1/fetch` with `{"url": "https://www.youtube.com/watch?v=Cwkej79U3ek"}`

If fallback recovery succeeds after a YouTube bot check: `extractor` and `fallbackUsed` say `btch-downloader`, there is one video format (`btch-mp4`) and one audio format (`btch-m4a`), and quality is limited to what the provider offers. Its links expire within a minute, so a stored answer like this is trusted for only `FALLBACK_LINK_TTL_SECONDS`. See [YouTube blocks and the fallback provider](#youtube-blocks-and-the-fallback-provider).

[Example response](examples/youtube-blocked-fallback.json).

### TikTok

`POST /api/v1/fetch` with `{"url": "https://www.tiktok.com/@scout2015/video/6718335390845095173"}`

- Several muxed formats (H.264 and other codecs); `compatible: true` marks the H.264 ones. No merge needed. Short links such as `vm.tiktok.com` are accepted.
- yt-dlp is primary; `@tobyg74/tiktok-api-dl` is the fallback (then `fallbackUsed` is set).


[Example response](examples/tiktok.json).

### Instagram (reel)

`POST /api/v1/fetch` with `{"url": "https://www.instagram.com/reel/DZYvGYIv1nr/"}`

- Reels, posts and TV. DASH formats are **video-only** (`requiresMerge: true`) and get their audio merged automatically; a few muxed formats are also offered.
- `durationSeconds` can be `null`. `mediaId` is the shortcode, so `/instagram/<shortcode>` works for reels and posts alike. Profile listing is not supported.
- Fallback providers (btch-downloader, then an optional cakkatrok endpoint) take over when yt-dlp is blocked, and `fallbackUsed` is set.


[Example response](examples/instagram.json).

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


[Example response](examples/twitter.json).

### Facebook

`POST /api/v1/fetch` with `{"url": "https://www.facebook.com/reel/1097374499488415"}`

- Reels and public videos, including `share/v/...` and `fb.watch` links (a share link is followed to the post). Two muxed formats plus DASH video-only formats that merge with the separate audio track.
- Facebook often gates content; posts that need a login return `LOGIN_REQUIRED` or `MEDIA_NOT_FOUND`.


[Example response](examples/facebook.json).

### Reddit

`POST /api/v1/fetch` with `{"url": "https://www.reddit.com/r/funny/comments/1bx4vqy/in_hot_pursuit/"}`

Native Reddit video is DASH: every video format is **video-only** (`requiresMerge: true`) with separate audio formats, and the server merges them for you. `redd.it` short links are accepted.


[Example response](examples/reddit.json).

### Vimeo

`POST /api/v1/fetch` with `{"url": "https://vimeo.com/826026805"}`

- HLS/DASH video-only formats (merge required) plus audio formats. If the watch page needs a login, the server retries through the public player URL automatically.
- DRM-protected videos cannot be downloaded and return `FORMAT_UNAVAILABLE`.


[Example response](examples/vimeo.json).

### Dailymotion

`POST /api/v1/fetch` with `{"url": "https://www.dailymotion.com/video/x84sh87"}`

Four muxed HLS formats (288p to 1080p) and **no separate audio formats**: the audio is inside the video. Some clips have no audio at the source.


[Example response](examples/dailymotion.json).

### Bluesky

`POST /api/v1/fetch` with `{"url": "https://bsky.app/profile/bsky.app/post/3l3vgf77uco2g"}`

Video posts only. Two HLS renditions (`hls-655`, `hls-1240`) and the original upload (`blob`, up to 1080p). `durationSeconds` is `null`; there are no separate audio formats.


[Example response](examples/bluesky.json).

### Streamable

`POST /api/v1/fetch` with `{"url": "https://streamable.com/hn8hq"}`

Two muxed MP4 files (`mp4-mobile`, `mp4`). The simplest response shape: no merge, no audio list.

[Example response](examples/streamable.json).

### Rutube

`POST /api/v1/fetch` with `{"url": "https://rutube.ru/video/private/caafe83ff1c6ed38d394635b83ece578/?p=IBgzQQrKH4qB1bqm_91x7Q"}`

Twenty muxed HLS formats, no separate audio. Some Rutube videos are blocked by region or network and return `403`-style failures.


[Example response](examples/rutube.json).

### SoundCloud (single track)

`POST /api/v1/fetch` with `{"url": "https://soundcloud.com/nasa/houston-we-have-a-podcast-4"}`

- Audio only: `formats` is empty and `audioFormats` lists the available tracks (HLS/HTTP MP3 and AAC). `mediaId` is SoundCloud's numeric track id.
- Profile and browse pages are rejected with `INVALID_URL`. DRM-protected (Go+) tracks return `FORMAT_UNAVAILABLE`.


[Example response](examples/soundcloud.json).

### SoundCloud through `POST /api/v1/fetch/audio`

`POST /api/v1/fetch/audio` with `{"url": "https://soundcloud.com/nasa/houston-we-have-a-podcast-4"}`

`/fetch/audio` returns just the audio options for any platform. Here the track already has real audio formats, so `requiresConversion` is `false`. For video-only sources it instead offers one `mp3-from-<formatId>` option that is converted with ffmpeg (`isConverted: true`).


[Example response](examples/soundcloud-audio.json).

### Snapchat (Spotlight)

`POST /api/v1/fetch` with `{"url": "https://www.snapchat.com/p/8af53eee-e298-40c4-9d6e-af20cf881b61/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYYnlvaXl5amp6AZ1H3xfEAZ1H2YQIAAAAAQ"}`

One MP4 format with no resolution or codec details (`quality` and `codec` are `null`), no audio list. Snapchat is served by yt-dlp's generic HTML5 extractor.

[Example response](examples/snapchat.json).

### Twitch (VOD)

`POST /api/v1/fetch` with `{"url": "https://www.twitch.tv/videos/2702797838"}`

VODs, including 50+ minute recordings: five muxed HLS qualities (160p up to 1080p60) and an `Audio_Only` track. `durationSeconds` is in seconds (3008 here).


[Example response](examples/twitch.json).

### Pinterest (video pin)

`POST /api/v1/fetch` with `{"url": "https://www.pinterest.com/pin/424605071136961057/"}`

A video pin: video-only and muxed formats plus an audio track. `pin.it` short links are accepted and resolved to the pin.


[Example response](examples/pinterest.json).

### Pinterest (board)

`POST /api/v1/fetch` with `{"url": "https://www.pinterest.com/pinterest/official-news/", "rangeStart": 1, "rangeEnd": 20}`

A board is returned as a collection: `mediaType: "carousel"` with one entry per pin in `items`, each with its own `formats` (`type: "video"`) or `source` (`type: "image"`). Use `rangeStart` / `rangeEnd` in the request to page through big boards (`metadata.truncated` tells you more exists). Ranged requests are never stored.


[Example response](examples/pinterest-board.json).

### Loom

`POST /api/v1/fetch` with `{"url": "https://www.loom.com/share/9245fa69349d4dfa8a8ade8b728ce1f6"}`

HLS video-only formats (merge required) plus a separate audio track. ffmpeg cannot read Loom's signed playlists, so `GET /stream` prepares this source on the server in every mode (`X-Blazfetch-Mode: prepare`).

[Example response](examples/loom.json).

### Newgrounds

`POST /api/v1/fetch` with `{"url": "https://www.newgrounds.com/portal/view/921925"}`

Public movies use the standard video response shape. The latest test network returned HTTP 403 (`EXTRACTOR_FAILED`); an explicit rate limit returns `PLATFORM_RATE_LIMITED`. Check the source from your deployment host.

[Example error response](examples/newgrounds.json).

### Tumblr

Public video passed stream and prepared-download checks. Transient dedicated-extractor failures can retry with the generic public-page extractor. Response fields match other yt-dlp video responses.

[Example response](examples/tumblr.json).

---


## Audio as MP3 (`AUDIO_FORCE_MP3`)

Recommended, and on in the shipped `.env.example` (if the variable is left out it is off). Set `AUDIO_FORCE_MP3=true` in `.env` (and restart the server) and every audio download is delivered as
an MP3, whatever the source format:

- **What clients see:** `POST /fetch`, `POST /fetch/audio` and `GET /media/...` list every audio option with
  `ext: "mp3"`, `codec: "mp3"` and `isConverted: true`. The `formatId`s do not change, so a download request still
  names the real source track. `filesizeBytes` is an estimate (duration at 192 kbps) with `filesizeApprox: true`,
  because the MP3 is re-encoded.
- **Already MP3:** a source that is MP3 already is passed through untouched.
- **`GET /stream` (`stream`, `auto`):** the track is converted live through ffmpeg (`libmp3lame`, 192 kbps) and piped
  to the client, so nothing is written to disk.
- **`GET /stream?mode=prepare` and `POST /download`:** the source is saved to a temporary file, converted, sent, and
  both files are deleted afterwards (also when the client cancels).
- **Filename and type:** `.mp3` and `Content-Type: audio/mpeg`.

The conversion is one lossy step from the best source track: `bestaudio` is selected and then encoded, so the MP3
is never better than the source (a 128 kbps source stays 128 kbps quality inside a 192 kbps file).

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
  "quality": "1080p",
  "filename": "My video"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Any URL from a supported platform domain |
| `formatId` | string | no (default `"best"`) | A `formatId` previously returned by `/fetch` or `/fetch/audio` — never a raw yt-dlp format string or shell argument. Omit it (or pass `"best"`) to skip picking a format entirely: the backend automatically selects the highest resolution for video (an H.264 file from 720p up, and the plain file rather than an HLS copy), or the highest-bitrate audio, preferring AAC/MP3 when it is within 80% of the top bitrate (converting to MP3 via ffmpeg if the source has no standalone audio track) |
| `kind` | `"video"` \| `"audio"` | yes | |
| `quality` | string | no | Informational only; doesn't affect selection |
| `filename` | string | no | Name for the finished file, without extension (max 200 characters). Defaults to the media title |

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
`Content-Type`, `Content-Length` (when known), and `Content-Disposition: attachment` with the
media title (or the `filename` given to `POST /download`) as the name.

A finished local file also answers `Range` requests (`Accept-Ranges: bytes`, `206 Partial Content`),
so a download that dropped halfway can be resumed. The file is deleted once its last byte has been
sent.

While the job runs, `progress` in `GET /jobs/:id` covers the whole job: the download up to 90, then
the conversion to H.264/AAC (when the source needs one) up to 99, and 100 when the file is ready.

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
| `stream` (default) | Bytes are piped from the source straight to the response: a plain file is passed through untouched, and a merge (video + audio) or an HLS remux runs through ffmpeg with `-c copy` and is piped live as fragmented MP4. No file on the server, first byte in 1 to 3 s. A failure **before the first byte** (the source cannot be streamed, ffmpeg or extraction failed, a timeout) falls back to `prepare` in the same request, with ffmpeg's quickest settings when a conversion cannot be avoided. | Speed, and the least load on the server |
| `prepare` | The server builds the file first (download, merge, and a transcode to H.264/AAC when the source is not browser-compatible), then sends it with its exact size, then deletes it. All in this one request, so nothing arrives until it is ready. When the chosen format is VP9/AV1/WebM and the source offers the same quality in H.264, that version is downloaded instead, so no re-encode is needed. | Guaranteed H.264/AAC, or sources that cannot stream |
| `auto` | Same as `stream`: it always tries to stream first (live merges and remuxes included), and if that fails **before the first byte** the server switches to `prepare` **in the same request**, so the client still just gets the file. Conversions on the fallback use the balanced settings (smaller file than `stream`'s). | Recommended for the frontend: fast when possible, works when not |

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
| Video-only format needing audio (e.g. YouTube 1080p+) | `stream`/`auto`: yt-dlp resolves video + best AAC audio and ffmpeg merges them (`-c copy`), piped live. `prepare` (and the fallback): the same merge written to a temporary MP4, then sent with its exact size |
| HLS video | `stream`/`auto`: remuxed live with `-c copy`. `prepare`: remuxed to a temporary MP4 |
| WebM, VP9/AV1/HEVC | the same quality in H.264 is used when the source offers it (a same-height twin, or the source's progressive H.264 MP4 when the pick was "best"); otherwise it is streamed as it is, and `prepare` converts it to H.264/AAC |
| MP3 (no standalone audio track, or `AUDIO_FORCE_MP3=true`) | `ffmpeg -vn -c:a libmp3lame -b:a 192k -f mp3`, streamed live (see [Audio as MP3](#audio-as-mp3-audio_force_mp3)) |

- **Stream first, prepare is the fallback:** a merge or remux written to a pipe has to be fragmented MP4. It
  plays in browsers, VLC and most players, but some phone galleries cannot open it, so a streamed video prefers
  an H.264 file (the same quality in H.264, or the source's progressive H.264 MP4 when the request was
  `formatId=best`) over VP9/AV1. Preparing puts load on the server, so it only runs when streaming fails
  before the first byte (Loom's signed HLS playlists, sources that refuse ffmpeg, an unavailable format). When
  the requested quality cannot be produced at all, the request is retried once with `best` instead of
  failing. Errors that preparing cannot fix (private, removed, login required) come back as JSON.
- **Slots are freed as soon as the response finishes,** so a client can start the next download right away.
- **Full speed from throttling hosts:** plain files are fetched in 10 MB ranged requests (YouTube throttles one
  long request to about playback speed). ffmpeg reads them through a relay on `127.0.0.1` that does the same, so
  live merges and remuxes run at full speed too; HLS playlists are read by ffmpeg directly.
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

- `YOUTUBE_FALLBACK_ENABLED=true` enables best-effort btch-downloader recovery for bot checks and transient extraction failures.
- `YOUTUBE_BLOCK_COOLDOWN_SECONDS` (default 600) pauses yt-dlp retries during a block.
- Successful fallback responses identify `extractor` and `fallbackUsed`; available quality depends on the provider.
- Short-lived provider links are refreshed at download time. `FALLBACK_LINK_TTL_SECONDS` defaults to 30.
- Private, deleted, age-restricted and geo-restricted failures are not bypassed. If recovery fails, the original error is returned.

For media-only proxy/EJS setup, see the [VPS guide](REQUIREMENTS.md#media-extraction-dependencies-and-optional-recovery). For an optional independent Cobalt provider, see [fallback setup](playlist-and-fallback.md#fallback-behavior).

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

### `GET /api/v1/media/<platform>/<id>/logs` (download logs for this media)

```
GET /api/v1/media/youtube/Cwkej79U3ek/logs
```

Returns persisted YouTube stream attempts, including delivery mode, fallback and errors. No per-visitor ownership check; optional API-key protection applies. Returns `404 MEDIA_NOT_FOUND` if no attempts exist.

```json
{
  "success": true,
  "platform": "youtube",
  "mediaId": "Cwkej79U3ek",
  "attempts": [
    { "requestId": "...", "startedAt": 1758901234567, "lines": [
      { "ts": 1758901234600, "level": "warn", "message": "Live streaming isn't possible for this pick (...) — preparing a compatible file on the server instead." },
      { "ts": 1758901240100, "level": "info", "message": "Download completed successfully." }
    ] }
  ]
}
```

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
`TURNSTILE_ENABLED=true`, `POST /fetch`, `POST /fetch/audio`, `GET /stream`, `POST /download` and playlist creation/polling need a passed check.
`GET /media/...` is never gated, even though it can extract missing or stale metadata like fetch does: it's the
endpoint a stable/shared link opens, so a brand-new visitor arriving from one sees the page immediately rather than
a CAPTCHA before they've done anything; it's still behind the same rate limiter as fetch. Configuration, statistics, platform lists and health do not require a Turnstile pass. Optional API-key protection still applies separately. Existing job delivery checks job ownership.

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

Requires `X-API-Key` when API protection is enabled. Returns only pass/fail flags; use `npm run diagnostics` for versions and database details.

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
