# Security policy

## Reporting a problem

Please report security issues **privately**, not in a public issue. Use GitHub's private reporting
("Security" tab, then "Report a vulnerability") on this repository, or start a private conversation through
https://github.com/ssanaullahrais/blazfetch-web/discussions and ask for a private channel. Include what you found,
how to reproduce it and, if you can, a suggested fix. You will get an answer as soon as possible.

Never post secrets (API keys, Cloudflare Turnstile secret keys, database URLs) in issues, discussions or chats. If one
leaks, rotate it in its dashboard first.

## What this project already does

- **No shell:** yt-dlp, ffmpeg and ffprobe are started with argument lists (`shell: false`), never through a shell, and
  every link is normalised to `http(s)` first, so a link cannot become a command-line option.
- **SSRF protection:** links are resolved and refused when they point at loopback, private, link-local, multicast or
  reserved addresses (IPv4 and IPv6, including IPv4-mapped, NAT64 and 6to4 forms). Redirects are followed by the server
  itself and every hop is checked again, so an allowed host cannot bounce a request to an internal address. Short links
  (`t.co`, `redd.it`, `fb.watch`, `pin.it`) are resolved this way before yt-dlp sees them, and must lead to a supported
  platform. Media URLs taken from the source page are checked before yt-dlp or ffmpeg fetches them, and ffmpeg may only
  open network protocols.
  - The check looks the name up once, and yt-dlp or ffmpeg look it up again, so a DNS server that answers differently
    the second time (DNS rebinding) is not fully covered. If the server can reach anything sensitive (a cloud metadata
    service, an admin panel), block private ranges for the app's outbound traffic at the firewall as well.
- **Owner-only jobs:** a job can only be read, downloaded or cancelled by the visitor who started it.
- **Safe headers:** download file names cannot inject headers (control characters, quotes and slashes are removed and the
  real name travels in `filename*`). Helmet sets the standard security headers.
- **CORS and cookies:** a wildcard `CORS_ALLOWED_ORIGINS` is refused in production; cookies are `HttpOnly`, `SameSite=Lax`
  and `Secure` in production.
- **Limits:** rate limits per IP address (never per cookie, which a client could simply drop), concurrency limits per
  visitor and per IP address, a cap on live-stats connections, a maximum download size, timeouts on every external process,
  and a 1 MB request body limit.
- **No public details:** `/health/ready` returns only pass/fail flags, and raw tool output is never sent to clients.
- **Optional Cloudflare Turnstile:** a signed, expiring pass cookie bound to the visitor; the secret key never leaves the
  server, and the check fails closed.
- **Privacy:** downloaded media is never stored (only metadata), and temporary files are removed.

## What you must do when you deploy

- Run behind HTTPS (Nginx and a certificate) and keep the app port closed to the internet.
- Set `CORS_ALLOWED_ORIGINS` to your real frontend origin, and `TRUST_PROXY=1` when you are behind Nginx.
- Keep `.env` out of git and readable only by the app user; use a database user with only the rights it needs.
- Keep yt-dlp, Node.js and your dependencies updated (`pip install -U yt-dlp`, `npm audit`).

