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
| Database (one of) | SQLite (bundled, nothing to install), PostgreSQL 14+, MySQL 8+ / MariaDB, MongoDB 6+ | choose during `npm run setup`; SQLite is the default |
| yt-dlp     | latest (update regularly — see below) | installed separately from npm deps |
| ffmpeg / ffprobe | 5.x+ | needed for merging, MP3 extraction, and output validation |
| Nginx      | 1.18+ | reverse proxy in front of Node |

## Installing system dependencies (Ubuntu/Debian)

```bash
# Node.js 20 (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Database: install ONLY the one you will use (SQLite needs nothing, it is bundled)
sudo apt-get install -y postgresql postgresql-contrib   # PostgreSQL
sudo apt-get install -y mariadb-server                  # or MySQL/MariaDB (mysql-server also works)
# MongoDB is not in Ubuntu's default repos: follow https://www.mongodb.com/docs/manual/administration/install-on-linux/

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

Blazfetch works with **SQLite, PostgreSQL, MySQL/MariaDB or MongoDB**. Use exactly one; they store
the same data (metadata cache, jobs, stats, never media files) and behave identically. The easiest
path is `npm run setup`, which asks which one you want and creates the tables. `npm run setup`
needs the database itself to exist first (except SQLite). Pick one section below.

| Database | Good for | Connection URL |
|---|---|---|
| SQLite (default) | single server, zero setup | none |
| PostgreSQL 14+ | recommended for production | `postgres://user:pass@localhost:5432/blazfetch` |
| MySQL 8+ / MariaDB | if you already run MySQL | `mysql://user:pass@localhost:3306/blazfetch` |
| MongoDB 6+ | if you already run MongoDB | `mongodb://localhost:27017/blazfetch` |

**SQLite** (nothing to create):

```bash
npm run setup -- --driver=sqlite
```

**PostgreSQL:**

```bash
sudo -u postgres psql -c "CREATE ROLE blazfetch WITH LOGIN PASSWORD 'change-me';"
sudo -u postgres psql -c "CREATE DATABASE blazfetch OWNER blazfetch;"
npm run setup -- --driver=postgres --url=postgres://blazfetch:change-me@localhost:5432/blazfetch
```

**MySQL / MariaDB:**

```bash
sudo mysql -e "CREATE DATABASE blazfetch CHARACTER SET utf8mb4;"
sudo mysql -e "CREATE USER 'blazfetch'@'localhost' IDENTIFIED BY 'change-me';"
sudo mysql -e "GRANT ALL ON blazfetch.* TO 'blazfetch'@'localhost'; FLUSH PRIVILEGES;"
npm run setup -- --driver=mysql --url=mysql://blazfetch:change-me@localhost:3306/blazfetch
```

**MongoDB** (the database and collections are created automatically on first use):

```bash
npm run setup -- --driver=mongodb --url=mongodb://localhost:27017/blazfetch
```

You can also set `DATABASE_DRIVER` and `DATABASE_URL` in `.env` yourself and run `npm run migrate`.
Special characters in a password must be URL-encoded inside the connection URL.

## Installing the app

```bash
git clone https://github.com/ssanaullahrais/blazfetch-social-downloader.git blazfetch-backend
cd blazfetch-backend
npm ci
npm run setup         # pick your database, writes .env and creates the tables
npm run diagnostics   # confirms the database, yt-dlp and ffmpeg are all reachable
```

`npm run setup` is interactive. On a server you can skip the prompts with flags, for example
`npm run setup -- --driver=sqlite` or `npm run setup -- --driver=mysql --url=mysql://...` (see Database setup above).
Edit `.env` afterwards for production values (see below).

## Environment variables

See [.env.example](../.env.example) for the full list with defaults. At minimum, production
deployments should set: `APP_ENV=production`, `DATABASE_DRIVER`, `DATABASE_URL` (not needed for SQLite), `APP_URL`, `CORS_ALLOWED_ORIGINS`
(never `*` in production), and review the concurrency/timeout/size limits for your VPS specs.

Never commit `.env` — it's already in `.gitignore`.

With SQLite the database is a single file (`DATABASE_SQLITE_PATH`, default `./data/blazfetch.sqlite3`). Keep it on persistent disk, outside any directory that is wiped on deploy.

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
- Your database port, if you use a server database: `5432` PostgreSQL, `3306` MySQL/MariaDB, `27017` MongoDB (bind to localhost only unless using a managed/remote DB)

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
npm run migrate   # safe to re-run on every deploy; only creates tables that are missing
pm2 start dist/index.js --name blazfetch-backend
pm2 save
pm2 startup   # follow the printed instructions to enable boot startup
```

Logs: `pm2 logs blazfetch-backend`. Update and redeploy:

```bash
git pull && npm ci && npm run build && npm run migrate && pm2 restart blazfetch-backend
```

## Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Do not expose port 4000 (the app) or your database port (5432 / 3306 / 27017) publicly — both should only be reachable via
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
