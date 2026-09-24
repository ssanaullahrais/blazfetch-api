# Blazfetch Backend — Deployment & System Requirements

## Supported operating systems

- Ubuntu 22.04 LTS or 24.04 LTS (recommended)
- Debian 12
- Any other reasonably current Linux distribution with Node.js 20+, a supported database (SQLite needs none), and Python 3
  available should work but isn't part of the primary test matrix.

Windows is fine for local development (this repo was scaffolded on Windows) but is not a
supported production target — the process management, signal handling, and file permission
guidance below all assume Linux.

## Minimum versions

| Component  | Minimum version | Notes |
|---|---|---|
| Node.js    | 20.x LTS | `engines.node` in package.json enforces this |
| PostgreSQL | 14 | earlier versions likely work but are untested |
| yt-dlp     | latest (update regularly — see below) | installed separately from npm deps |
| ffmpeg / ffprobe | 5.x+ | needed for merging, MP3 extraction, and output validation |
| Nginx      | 1.18+ | reverse proxy in front of Node |

## Installing system dependencies (Ubuntu/Debian)

```bash
# Node.js 20 (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PostgreSQL (optional: SQLite needs nothing)
sudo apt-get install -y postgresql postgresql-contrib

# ffmpeg / ffprobe
sudo apt-get install -y ffmpeg

# yt-dlp (pip install keeps it easy to update independently of apt)
sudo apt-get install -y python3-pip
python3 -m pip install -U yt-dlp

# Nginx
sudo apt-get install -y nginx

# PM2 (process manager)
sudo npm install -g pm2
```

## Database setup

The fastest path is `npm run setup`, which asks which database to use and creates the tables. For a
production VPS PostgreSQL is recommended; SQLite also works for a single-server deployment, and
MySQL/MariaDB and MongoDB are supported too.

```bash
sudo -u postgres psql -c "CREATE ROLE blazfetch WITH LOGIN PASSWORD 'change-me';"
sudo -u postgres psql -c "CREATE DATABASE blazfetch OWNER blazfetch;"
npm run setup -- --driver=postgres --url=postgres://blazfetch:change-me@localhost:5432/blazfetch
```

Or set `DATABASE_DRIVER` and `DATABASE_URL` in `.env` yourself and run `npm run migrate`. MySQL uses
`mysql://user:pass@localhost:3306/blazfetch`, MongoDB `mongodb://localhost:27017/blazfetch`. SQLite
needs only `DATABASE_DRIVER=sqlite` (optionally `DATABASE_SQLITE_PATH`), no URL.

## Environment variables

See [.env.example](../.env.example) for the full list with defaults. At minimum, production
deployments should set: `APP_ENV=production`, `DATABASE_DRIVER`, `DATABASE_URL` (not needed for SQLite), `APP_URL`, `CORS_ALLOWED_ORIGINS`
(never `*` in production), and review the concurrency/timeout/size limits for your VPS specs.

Never commit `.env` — it's already in `.gitignore`.

## Recommended VPS specifications

| Tier | vCPU | RAM | Disk | Notes |
|---|---|---|---|---|
| Minimum | 2 | 2 GB | 20 GB SSD | Low concurrency (MAX_CONCURRENT_DOWNLOADS_GLOBAL=2-3), ffmpeg transcoding is CPU-bound |
| Recommended | 4 | 4-8 GB | 40 GB SSD | Comfortable for moderate traffic with several concurrent merges/transcodes |
| High traffic | 8+ | 16 GB+ | 80 GB+ SSD | Scale MAX_CONCURRENT_DOWNLOADS_GLOBAL accordingly; consider multiple app instances behind Nginx |

ffmpeg transcoding (H.264/AAC compatibility pass) is the most CPU-intensive operation in this
backend — size CPU around your expected concurrent transcode count, not just request volume.

## Required ports

- `4000` (or your configured `PORT`) — Node app, bound to `127.0.0.1` behind Nginx, not exposed publicly
- `443` / `80` — Nginx (public)
- `5432` — PostgreSQL, if used (bind to localhost only unless using a managed/remote DB)

## File permissions & temporary storage

- `TEMP_DIR` (default `./tmp`) must be writable by the process user and ideally on a separate
  disk/partition from the OS if download volume is high — it holds in-flight merges/transcodes
  only, never a permanent media library.
- No media is retained after a job reaches `completed`/`failed`/`cancelled`/`expired`; startup
  also sweeps `TEMP_DIR` for directories older than 6 hours left behind by an unclean shutdown.
- Ensure the app's system user does **not** have write access outside `TEMP_DIR` and the app
  directory — yt-dlp and ffmpeg run as this user.

## Nginx reverse proxy

```nginx
server {
    listen 443 ssl http2;
    server_name api.your-domain.example;

    ssl_certificate     /etc/letsencrypt/live/api.your-domain.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.your-domain.example/privkey.pem;

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
        proxy_buffering off; # required so download streams flush to the client promptly
    }
}
```

SSL via Let's Encrypt:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.your-domain.example
```

## Process management (PM2)

```bash
npm run build
pm2 start dist/index.js --name blazfetch-backend
pm2 save
pm2 startup   # follow the printed instructions to enable boot startup
```

Logs: `pm2 logs blazfetch-backend`. Restart after deploy: `pm2 restart blazfetch-backend`.

## Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Do not expose port 4000 (the app) or your database port (e.g. 5432 for Postgres) publicly — both should only be reachable via
localhost/Nginx.

## Updating yt-dlp

Extractors break as platforms change; update independently of app deploys:

```bash
python3 -m pip install -U yt-dlp
yt-dlp --version   # confirm
```

Consider a weekly cron job:

```bash
# /etc/cron.weekly/update-ytdlp
#!/bin/sh
python3 -m pip install -U yt-dlp
```

## Updating Node dependencies

```bash
npm outdated
npm update
npm audit fix
```

Re-run `npm run build && npm test` before redeploying.

## Backup considerations

- Back up the database only — it holds metadata cache, stats, and job records, never media files.
  A scheduled dump (daily `pg_dump`, `mysqldump` or `mongodump`, or a copy of the SQLite file) is
  sufficient given the low write volume.
- `TEMP_DIR` never needs backing up — it's transient by design.
- Back up `.env` (encrypted / in a secrets manager) separately from the repo.

## Troubleshooting commands

```bash
npm run diagnostics          # Node/database/yt-dlp/ffmpeg/ffprobe status in one command
curl localhost:4000/health/ready
yt-dlp --version
ffmpeg -version
sudo -u postgres psql -c "\l"           # PostgreSQL only: confirm the blazfetch database exists
pm2 logs blazfetch-backend --lines 200
sudo journalctl -u nginx -n 100
```

## Shared hosting

Not supported as a production target — this backend requires spawning yt-dlp/ffmpeg as child
processes and running persistent Node background work, both of which typical shared PHP/cPanel
hosting disallows. A VPS or container platform (Docker on any VPS, or a container-based PaaS with
custom Dockerfile support) is the expected deployment target.
