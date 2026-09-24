# Blazfetch Backend: VPS Deployment Guide

Follow the **Quick start** top to bottom on a fresh Ubuntu server and you will have the API running
behind HTTPS. Everything after it is reference material (specs, updates, backups, troubleshooting).

## Requirements at a glance

| | |
|---|---|
| **OS** | Ubuntu 22.04 / 24.04 LTS (recommended) or Debian 12. Other current Linux distros should work. Windows is fine for local development only. |
| **Server size** | 2 vCPU / 2 GB RAM / 20 GB SSD minimum. 4 vCPU / 4-8 GB recommended (see [sizing](#server-sizing)). |
| **Software** | Node.js 20+, yt-dlp, ffmpeg (includes ffprobe), Nginx, PM2 |
| **Database (pick one)** | SQLite (nothing to install, default), PostgreSQL 14+, MySQL 8+ / MariaDB, or MongoDB 6+ |
| **Domain** | A domain or subdomain pointing at the server (for HTTPS) |

Shared/cPanel hosting is not supported: the app must run yt-dlp and ffmpeg as child processes and
keep a Node process running. Use a VPS or any container platform.

## Quick start

### 1. Prepare the server

Log in as a non-root user with sudo, then:

```bash
sudo apt-get update
sudo apt-get install -y git curl ffmpeg python3 nginx

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# yt-dlp (standalone download, updates itself with `sudo yt-dlp -U`) and the process manager
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
sudo npm install -g pm2
```

Check everything is installed:

```bash
node --version && yt-dlp --version && ffmpeg -version | head -1 && ffprobe -version | head -1
```

### 2. Choose and prepare a database

Use exactly one. They store the same data (metadata cache, jobs, stats, never media files) and the
app behaves identically on each.

| Database | Status | Best for | Do this first | Connection URL |
|---|---|---|---|---|
| **SQLite** (default) | ✅ Confirmed | one server, zero setup | nothing | none needed |
| **PostgreSQL** | ✅ Confirmed | production, if you already run it | install + create DB (below) | `postgres://blazfetch:change-me@localhost:5432/blazfetch` |
| **MySQL / MariaDB** | ✅ Confirmed | if you already run it | install + create DB (below) | `mysql://blazfetch:change-me@localhost:3306/blazfetch` |
| **MongoDB** | ✅ Confirmed | if you already run it | install (below) | `mongodb://localhost:27017/blazfetch` |

Confirmed = tested end to end from a fresh clone (setup, server start, fetch, download, and data written to the database). All four work on a production VPS.

Skip the rest of this step if you choose SQLite. Otherwise follow only your database's section:

#### PostgreSQL

```bash
sudo apt-get install -y postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE ROLE blazfetch WITH LOGIN PASSWORD 'change-me';"
sudo -u postgres psql -c "CREATE DATABASE blazfetch OWNER blazfetch ENCODING 'UTF8' TEMPLATE template0;"
```

For a managed/remote PostgreSQL that requires SSL, also set `DATABASE_SSL=true` in `.env`.

#### MySQL / MariaDB

```bash
sudo apt-get install -y mariadb-server
sudo mysql -e "CREATE DATABASE blazfetch CHARACTER SET utf8mb4;"
sudo mysql -e "CREATE USER 'blazfetch'@'localhost' IDENTIFIED BY 'change-me';"
sudo mysql -e "GRANT ALL ON blazfetch.* TO 'blazfetch'@'localhost'; FLUSH PRIVILEGES;"
```

#### MongoDB

MongoDB is not in Ubuntu's default repositories. Install it by following the
[official guide](https://www.mongodb.com/docs/manual/administration/install-on-linux/). The database
and collections are created automatically on first use, so there is nothing else to create.

Replace `change-me` with a real password. Special characters in a password must be URL-encoded
inside the connection URL.

### 3. Get the code

```bash
git clone https://github.com/ssanaullahrais/blazfetch-api.git blazfetch-backend
cd blazfetch-backend
npm ci
```

### 4. Run the setup wizard

```bash
npm run setup
```

It asks which database you chose, saves it to `.env`, tests the connection and creates the tables.
Prefer no prompts? Pass the answers as flags:

```bash
npm run setup -- --driver=sqlite
npm run setup -- --driver=postgres --url=postgres://blazfetch:change-me@localhost:5432/blazfetch
npm run setup -- --driver=mysql    --url=mysql://blazfetch:change-me@localhost:3306/blazfetch
npm run setup -- --driver=mongodb  --url=mongodb://localhost:27017/blazfetch
```

If it says it could not connect, re-check the URL and that the database server is running, then run
it again.

### 5. Set the production values

Edit `.env` (`nano .env`) and set at least:

```
APP_ENV=production
APP_URL=https://api.your-domain.example
CORS_ALLOWED_ORIGINS=https://your-frontend.example
```

`CORS_ALLOWED_ORIGINS` must list your real frontend origin(s) (comma separated). Never use `*` in
production. If the frontend and `/api` share one domain (recommended), CORS is not used at all, so do not add
`localhost` origins in production. The other limits (concurrency, timeouts, sizes) have sensible defaults: see
[.env.example](../.env.example) and the [sizing](#server-sizing) table below.

`.env` is already in `.gitignore`; never commit it.

Settings you may want to review for a public deployment:

| Setting | Why |
|---|---|
| `DEFAULT_DOWNLOAD_MODE` | **Use `auto` for a public site.** It streams files that already play on phones (plain H.264 MP4) and prepares a compatible MP4 on the server for the rest (live merges, WebM, VP9/AV1/HEVC, HLS). `stream` never falls back, so those formats return an error. Clients can always choose with `?mode=` |
| `TURNSTILE_ENABLED`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Optional Cloudflare bot check in front of fetch, stream and download. Set up in [Cloudflare Turnstile](#cloudflare-turnstile-optional) below. Off by default |
| `INSTAGRAM_COOKIES_PATH` | Optional. Instagram often blocks datacenter IPs; a `cookies.txt` from a logged-in browser lets yt-dlp through. Without it the backup provider is used |
| `YOUTUBE_FALLBACK_ENABLED` | Leave `true`: if YouTube blocks the server's IP, a fallback provider serves the request |
| `REVALIDATE_AFTER_SECONDS` | How often stored media is re-checked for deletion (default 7 days) |
| `RATE_LIMIT_MAX_GUEST`, `RATE_LIMIT_MAX_DOWNLOAD`, `MAX_CONCURRENT_DOWNLOADS_*` | Protect the server's bandwidth and CPU |


### 6. Check, build and start

```bash
npm run diagnostics   # database, yt-dlp, ffmpeg, ffprobe should all show OK
npm run build
pm2 start dist/index.js --name blazfetch-backend
pm2 save
pm2 startup           # run the command it prints so the app restarts after a reboot
```

Start PM2 from inside the project folder so the app finds its `.env`. Confirm it is up:

```bash
curl localhost:4000/health/ready
```

`/health/ready` is public and returns only pass/fail flags (`database`, `ytdlp`, `ffmpeg`). Versions and the database
type are not exposed; `npm run diagnostics` on the server shows them.

### 7. Put Nginx and HTTPS in front

Create `/etc/nginx/sites-available/blazfetch` (replace the domain):

```nginx
server {
    listen 80;
    server_name api.your-domain.example;

    client_max_body_size 5m;
    proxy_read_timeout 600s;   # long-lived download streams
    proxy_send_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off; # so download streams reach the client promptly
    }
}
```

Enable it and get a free certificate (Certbot adds the HTTPS settings for you):

```bash
sudo ln -s /etc/nginx/sites-available/blazfetch /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.your-domain.example
```

### 8. Lock down the firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Do not open port 4000 (the app) or your database port (5432 / 3306 / 27017) to the internet. The app
listens for Nginx on localhost, and databases should only accept local connections.

**Done.** Test from anywhere: `curl https://api.your-domain.example/health/ready`

## Everyday operations

**Deploy an update:**

```bash
cd blazfetch-backend
git pull && npm ci && npm run build && npm run migrate && pm2 restart blazfetch-backend
```

`npm run migrate` applies any database changes that have not run yet (it keeps a `schema_migrations` record) and does nothing when up to date, so it is safe to run on every deploy. It upgrades an existing database in place without losing stored data.

**Background work:** the app runs two small jobs by itself, nothing to schedule: a sweep of old files in
`TEMP_DIR` (every 10 minutes) and the weekly re-check of stored media (a batch every 30 minutes, one item
at a time with a pause between, so source sites are never hammered). Run **one app instance per
database**: both jobs and the concurrency limits live inside the process, so a second instance would
only repeat some checks. Tune or disable the re-check with `REVALIDATE_*` in `.env` (`REVALIDATE_ENABLED=false`).

**Update yt-dlp** (do this regularly: extractors break when platforms change):

```bash
sudo yt-dlp -U
yt-dlp --version
```

To automate it weekly, create `/etc/cron.weekly/update-ytdlp` (mode `755`) containing:

```sh
#!/bin/sh
/usr/local/bin/yt-dlp -U
```

**Update Node dependencies:** `npm outdated`, `npm update`, `npm audit fix`, then `npm run build && npm test`
before redeploying.

**View logs:** `pm2 logs blazfetch-backend --lines 200`

## Reference

### Cloudflare Turnstile (optional)

Adds a bot check in front of fetching and downloading. It is free and needs no visible CAPTCHA for most visitors.

1. In the Cloudflare dashboard open **Turnstile** and add a widget for your domain. Choose **Managed** mode.
2. Copy the **Site key** and **Secret key**.
3. In the backend `.env`:

   ```
   TURNSTILE_ENABLED=true
   TURNSTILE_SITE_KEY=<site key>
   TURNSTILE_SECRET_KEY=<secret key>
   ```

4. `pm2 restart <name> --update-env`. The frontend reads the site key from the backend (`GET /api/v1/config`), so it needs
   no setting of its own. To turn the check off, set `TURNSTILE_ENABLED=false` and restart.

To test locally without a Cloudflare account use Cloudflare's dummy keys (they only work on localhost): site key
`1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA` always pass; `2x00000000000000000000AB` and
`2x0000000000000000000000000000000AA` always fail.

Deployment notes for Turnstile:

- Keep the frontend and `/api` on the **same domain** (the pass is an HttpOnly cookie and downloads are plain browser navigations that carry it). Nginx must pass `/api/v1/config` and `/api/v1/turnstile/verify` like every other `/api/` route, which the sample config in this guide already does.
- Add your production domain to the widget's hostname list in Cloudflare (and `localhost` if you test locally with real keys).
- The server needs outbound HTTPS to `challenges.cloudflare.com`. Behind a firewall that blocks outbound traffic, allow it.
- Put the secret key only in the server's `.env` (never in git, the frontend or chat). If it leaks, rotate it in Cloudflare and restart with `pm2 restart <name> --update-env`.
- Viewing stored pages (`/youtube/<id>`), the platform list and health checks stay open, so search engines can still read your pages.

If a visitor sees "security check" errors: check the hostname is added to the widget in Cloudflare, that the secret is
correct, and that the server can reach `challenges.cloudflare.com` (outbound HTTPS). The check fails closed by design.

### Server sizing

| Tier | vCPU | RAM | Disk | Notes |
|---|---|---|---|---|
| Minimum | 2 | 2 GB | 20 GB SSD | Low concurrency (`MAX_CONCURRENT_DOWNLOADS_GLOBAL=2-3`) |
| Recommended | 4 | 4-8 GB | 40 GB SSD | Comfortable for moderate traffic with several concurrent merges/transcodes |
| High traffic | 8+ | 16 GB+ | 80 GB+ SSD | Raise `MAX_CONCURRENT_DOWNLOADS_GLOBAL`; consider several app instances behind Nginx |

ffmpeg transcoding (the H.264/AAC compatibility pass) is the most CPU-heavy operation, so size CPU
around your expected number of simultaneous transcodes, not just request volume. With `DEFAULT_DOWNLOAD_MODE=auto`,
high-quality YouTube downloads and other non-H.264 sources are prepared on the server, so plan CPU and `TEMP_DIR`
space for them (a few GB free per concurrent download).

### Ports

| Port | Used by | Exposure |
|---|---|---|
| `4000` (or your `PORT`) | Node app | localhost only, behind Nginx |
| `80` / `443` | Nginx | public |
| `5432` / `3306` / `27017` | PostgreSQL / MySQL / MongoDB (if used) | localhost only unless using a managed/remote database |

### Storage and permissions

- **SQLite:** the database is one file (`DATABASE_SQLITE_PATH`, default `./data/blazfetch.sqlite3`).
  Keep it on persistent disk, outside any folder that gets wiped on deploy.
- **`TEMP_DIR`** (default `./tmp`) must be writable by the app user. It holds in-flight merges and
  transcodes only, never a permanent media library, and ideally sits on its own disk if download
  volume is high.
- No media is kept after a job finishes, fails, is cancelled or expires. On startup the app also
  deletes leftovers in `TEMP_DIR` older than 6 hours from any unclean shutdown.
- Run the app as a regular user that cannot write outside `TEMP_DIR`, the data folder and the app
  directory: yt-dlp and ffmpeg run as this user.

### Backups

- Back up the **database only**. It holds the permanent media store (every fetched item's metadata, kept forever), statistics and job records, never media files. That store grows over time and cannot be rebuilt exactly, so a regular backup matters more than before.
  Use a scheduled dump: `pg_dump`, `mysqldump` or `mongodump`, or simply copy the SQLite file.
- `TEMP_DIR` never needs backing up.
- Keep a copy of `.env` in a secrets manager, separate from the repo.

### Troubleshooting

Problems seen on real deployments are listed here with their fixes. After any update, run `git pull --ff-only && npm ci && npm run build && npm run migrate && pm2 restart <name> --update-env && pm2 save`, then check `/health/ready`.

```bash
npm run diagnostics                      # database, yt-dlp, ffmpeg and ffprobe status in one command
curl localhost:4000/health/ready         # the app's own readiness check (HTTP 503 if something is missing)
pm2 status && pm2 logs blazfetch-backend --lines 200
sudo journalctl -u nginx -n 100
```

| Symptom | Likely cause and fix |
|---|---|
| Setup says it could not connect | Wrong URL, wrong password, or the database server is not running. For PostgreSQL/MySQL the database must already exist. |
| `diagnostics` shows yt-dlp or ffmpeg missing | Not installed or not on `PATH`: repeat step 1, or set `YTDLP_PATH` / `FFMPEG_PATH` in `.env`. |
| A platform suddenly stops working | Update yt-dlp (see above); extractors break as sites change. |
| Browser shows a CORS error | Add your frontend's origin to `CORS_ALLOWED_ORIGINS` and restart with `pm2 restart blazfetch-backend`. |
| 502 from Nginx | The app is not running: check `pm2 status` and the logs. |
| YouTube fails with "Sign in to confirm you're not a bot" | YouTube temporarily blocked the server's IP. The fallback provider takes over automatically (check `fallbackUsed` in responses); the block usually clears in minutes to hours. Fewer repeated requests and the media store help. |
| Downloaded video is black or cannot be shared on a phone (WhatsApp, gallery) | Update to the latest version and set `DEFAULT_DOWNLOAD_MODE=auto`: older versions streamed VP9/AV1, WebM and fragmented MP4 as-is, which phones cannot play. |
| An Instagram link shows only a thumbnail or fails, but works locally | yt-dlp is blocked from the server's IP. Check with `yt-dlp -J "<link>"` on the server; add `INSTAGRAM_COOKIES_PATH` if it asks for a login. After fixing, use the app's Refresh button once on that link to replace the stored result. |
| A YouTube download stops after a few minutes with `PROCESS_TIMEOUT` ("ffmpeg process timed out") | The chosen format needed a slow re-encode (VP9/AV1 4K/1440p) on a small CPU. Current versions pick 1080p H.264 for "best", which needs no re-encode. For manually chosen 4K/AV1 formats, raise `FFMPEG_TIMEOUT_MS` (default 180000) or use a bigger server. |
| Message "The server is busy or you already have a download running" | Each visitor may run 1 download at a time (`MAX_CONCURRENT_DOWNLOADS_PER_GUEST`) and the server 10 (`MAX_CONCURRENT_DOWNLOADS_GLOBAL`). It clears when the running download ends. Raise the limits only if the server has CPU to spare. |
| A carousel shows photos as videos, duplicates, or an old wrong result stays after you deploy a fix | Results are stored in the database and reused. After updating, open the page and click **Refresh** once (or `POST /fetch` with `"forceRefresh": true`) to replace the stored result. |
| "Backup source" badge on Instagram | The main extractor (yt-dlp) is blocked from the server's IP and the backup provider answered. Fixes: `INSTAGRAM_COOKIES_PATH` with a `cookies.txt` from a throwaway logged-in account, or a residential proxy. Never use a personal account. |
| A platform (for example Rutube) fails only from the server with a 504 or 403 | The site blocks or times out datacenter IPs. Try later or from another network; nothing to fix in the app. |
| New settings in `.env` do not take effect | Restart with `pm2 restart <name> --update-env`, then `pm2 save`. Check the process name with `pm2 status` (this guide uses `blazfetch-backend`; yours may differ). |
| The status button is red but the site works | `/health/ready` must be reachable through Nginx (`location /health`). Check `curl https://your-domain/health/ready`. |
| Old localhost origin still in `CORS_ALLOWED_ORIGINS` | Remove `localhost` entries in production, and if the app and `/api` share a domain CORS is not used at all. |
| Visitors see "security check" errors | Turnstile is on. Check the domain is in the widget's hostname list in Cloudflare, `TURNSTILE_SECRET_KEY` is right, and the server can reach `challenges.cloudflare.com`. A page opened before you changed keys holds an old token: reload it. To switch the check off: `TURNSTILE_ENABLED=false`, then `pm2 restart <name> --update-env`. |
| Downloads cut off partway | Nginx `proxy_read_timeout` too low, or `proxy_buffering` left on. |

## License

Free to use, modify and deploy (including on your own VPS), but not to sell, and the official frontend must keep its footer credit. See [LICENSE](../LICENSE) and [AGENTS.md](../AGENTS.md).
