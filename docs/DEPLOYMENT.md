# Deploying Relay to production

Relay is one Python process that serves the API, the live stream and the built UI. Production needs three things:

1. **HTTPS in front of it.** Secrets travel in a header, so a network hop must be encrypted. With `RELAY_ENVIRONMENT=production`,
   Relay refuses to start unless `RELAY_PUBLIC_BASE_URL` is an `https://` URL. It also refuses plain-HTTP API requests, redirects
   plain-HTTP pages, marks cookies `Secure` and sends HSTS.
2. **A persistent disk** for `data/` (the SQLite database and uploads), or Postgres plus S3-compatible storage.
3. **One worker.** Rate limits and live-event fan-out are in memory. One process comfortably handles a personal or team workload.
   Running several workers would need a shared bus (Redis pub/sub) and a shared limiter. That isn't built.

## Option A: Docker + Caddy (automatic HTTPS)

Requirements: a server with Docker, and a DNS name (for example `relay.example.com`) pointing at it with ports 80 and 443 open.

```bash
git clone <your repo> relay && cd relay
cp .env.example .env            # adjust limits/retention if you like
export RELAY_DOMAIN=relay.example.com
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec relay python -m app.cli create-user you
```

Caddy gets and renews the TLS certificate. The `relay-data` volume holds the database and uploads, so back it up.
Webhook URLs become `https://relay.example.com/api/webhooks/<id>`.

## Option B: a VM or this PC behind any reverse proxy

```powershell
# .env
RELAY_ENVIRONMENT=production
RELAY_PUBLIC_BASE_URL=https://relay.example.com
```

```powershell
cd backend
..\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8100 --proxy-headers --forwarded-allow-ips 127.0.0.1
```

Proxy requirements (nginx, Caddy, IIS, Cloudflare Tunnel and others):
- Forward `X-Forwarded-For` and `X-Forwarded-Proto`. List the proxy's address in `--forwarded-allow-ips`. Without this, Relay
  sees every request as plain HTTP from the proxy: production refuses them, and rate limits act per proxy, not per client.
- **Don't buffer** `/api/app/stream` (Server-Sent Events). For nginx use `proxy_buffering off; proxy_read_timeout 1h;`.
  Relay already sends `X-Accel-Buffering: no`.
- Allow request bodies up to `RELAY_MAX_UPLOAD_BYTES` plus about 1 MB (nginx: `client_max_body_size 27m;`).

Exposing the PC without opening ports: `cloudflared tunnel --url http://127.0.0.1:8100` gives an https URL. Set
`RELAY_PUBLIC_BASE_URL` to it.

## Storage

- **Local (default):** files go to `RELAY_STORAGE_DIR` (`data/uploads`) under random names, outside anything the web server
  serves. They are only downloadable through `/api/app/attachments/<id>` by the signed-in owner.
- **S3-compatible (AWS S3, Cloudflare R2, Backblaze B2, MinIO):** `pip install -r backend/requirements-s3.txt`, then set
  `RELAY_STORAGE_BACKEND=s3`, `RELAY_S3_BUCKET`, optionally `RELAY_S3_ENDPOINT_URL` / `RELAY_S3_REGION`, and the standard
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Keep the bucket private: Relay streams files through its own authenticated endpoint.
  Startup checks that the bucket is reachable.

## Database

SQLite (WAL mode) is the default and fine for one process. For Postgres, `pip install "psycopg[binary]"` and set
`RELAY_DATABASE_URL=postgresql+psycopg://user:pass@host/relay`. Migrations run automatically on start.

## Backups

Stop Relay (or use `sqlite3 data/relay.db ".backup backup.db"`) and copy `data/relay.db` and `data/uploads/`. With S3, back up the
bucket separately.

## Operational notes

- First account: create it with `python -m app.cli create-user`. Browser setup from another machine needs `RELAY_SETUP_TOKEN`.
- Retention runs hourly: messages older than `RELAY_MESSAGE_RETENTION_DAYS` (pinned ones are kept), request logs and audit entries.
- Logs never include secrets or payload bodies. Request IDs (`X-Request-ID`) tie a client's response to the delivery log.
- Interactive API docs at `/api/docs` are switched off in production.
