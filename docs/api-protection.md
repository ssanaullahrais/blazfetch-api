# API-key setup

Optional server-to-server protection. No user accounts or automatic key generation.

## 1. Backend

Set in the private backend `.env`:

```dotenv
API_AUTH_ENABLED=true
API_AUTH_KEY=<your private key>
HOST=127.0.0.1
TRUST_PROXY=1
```

- Supply a unique key: 32–256 printable ASCII characters, no whitespace.
- Invalid configuration prevents startup.
- All `/api/v1/*` routes and `/health/ready` require `X-API-Key`; `/health` stays public.
- Missing or incorrect keys return `401 API_AUTH_REQUIRED`.
- Keep port 4000 private. For containers, use a private network instead of a loopback-only bind.

## 2. Official frontend

Keep `VITE_API_BASE` empty. The browser calls the website proxy, which adds the key privately.

**Local development / preview:** set in frontend `.env.local`, then restart Vite:

```dotenv
BLAZFETCH_API_KEY=<same private key>
```

**Production:** create a private Nginx snippet, readable only by the operator and Nginx master:

```nginx
# /etc/nginx/snippets/blazfetch-api-key.conf
proxy_set_header X-API-Key "<same private key>";
```

Include it inside the website's existing `/api/` and `/health` proxy locations:

```nginx
include /etc/nginx/snippets/blazfetch-api-key.conf;
```

Keep `proxy_buffering off` and the download timeouts. Run `sudo nginx -t`, reload Nginx, and restart the backend with `pm2 restart blazfetch-backend --update-env`.

The Vite proxy runs only during development/preview; a static `dist/` build needs Nginx or another server-side proxy. Both proxies replace caller-supplied keys.

## 3. Check

From a trusted server client, send the key in the `X-API-Key` header over HTTPS.

| Request | Expected |
|---|---|
| `/api/v1/platforms`, no key or wrong key | HTTP 401 |
| `/api/v1/platforms`, correct key | HTTP 200 |
| `/health`, no key | HTTP 200 |
| Official website: fetch, completed download, live stats | Works without exposing the key to the browser |

## Change or disable

- **Rotate:** update the backend and proxy keys together, then restart/reload during maintenance.
- **Disable:** set `API_AUTH_ENABLED=false`, restart the backend, and remove the unused proxy key.

## Essential limits

- Never put the key in URLs, cookies, `VITE_*`, browser code, Git, logs or public config dumps.
- Do not inject it into a public API-domain proxy; that would give every caller access.
- The public website proxy remains accessible to automation. Keep Turnstile and rate/concurrency limits enabled as needed.
- This does not hide browser Network-tab requests or prevent someone running their own copy. CORS is not authentication.
