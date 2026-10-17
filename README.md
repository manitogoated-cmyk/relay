# Relay: your own webhook platform

Relay lets you create webhooks, paste their URL and secret into any app, script or agent, and watch messages and files arrive
live in your own dashboard. It is self-hosted and independent of any chat service.

- **Webhook Center**: create webhooks with a name, description, icon and colour. You can copy URLs, rotate or revoke secrets, issue
  a new URL, enable, disable or delete a webhook, see last-used time, 24-hour stats and a log of every request, and send test messages.
- **Live feed**: text, Markdown, rich cards (fields, links, colours, thumbnails, images, footers, timestamps), expandable JSON,
  image previews, file downloads and status colours. Updates arrive over Server-Sent Events, and the feed reconnects and catches up by itself.
- **Channels**: General Notifications, Application Logs, AI Agent Updates, Errors and Warnings and File Transfers, plus your own.
  You get unread counts, search, filters (status, type, files, pinned, unread, source, date range, archive), pins, archiving and
  clearing history.
- **Security**: 256-bit secrets stored only as SHA-256 hashes and shown once. Credentials go in the Authorization header,
  never the URL. Rate limits, size limits, upload type checks done on the bytes, private attachments, signed-in dashboard, CSRF
  protection, a CSP, request IDs, a delivery log, an audit log, idempotency keys and configurable retention.

Stack: FastAPI + SQLAlchemy/Alembic (SQLite by default) · React 18 + Vite + TypeScript · SSE.

## Run it locally (Windows)

```powershell
cd C:\Users\manit\relay
powershell -File scripts\setup.ps1      # venv + Python deps, npm install, UI build
powershell -File scripts\dev.ps1        # http://127.0.0.1:8100 (migrations run on start)
```

Open http://127.0.0.1:8100. On first run the page asks you to create the owner account (this only works from the same machine).
You can also run `.venv\Scripts\python -m app.cli create-user <name>` from `backend\`.

For UI hot reload, also run `npm run dev` in `frontend\` and use http://127.0.0.1:5174. It proxies `/api` to port 8100.

Send a message (the Webhook Center shows the exact URL and a ready-made command when you create a webhook):

```bash
curl -X POST "http://127.0.0.1:8100/api/webhooks/<id>" \
  -H "Authorization: Bearer <secret>" -H "Content-Type: application/json" \
  -d '{"title":"Agent Update","message":"The task has completed successfully.","status":"success"}'

curl -X POST "http://127.0.0.1:8100/api/webhooks/<id>" -H "Authorization: Bearer <secret>" \
  -F 'payload_json={"message":"Nightly report"}' -F "files=@report.pdf" -F "files=@chart.png"
```

To reach it from the internet without a server, run `scripts\serve-public.ps1` (Cloudflare quick tunnel). See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#option-c-this-pc-through-a-cloudflare-quick-tunnel-whats-running-now).

The in-app **Docs** page covers every field, the file rules, limits, response codes, and examples in curl, Python, Node and PowerShell.

## Checks

```powershell
powershell -File scripts\test.ps1   # ruff, pytest (unit, API, live server + SSE), tsc, eslint, vitest, build
```

## Admin commands (`backend\`)

| Command | What it does |
|---|---|
| `..\.venv\Scripts\python -m app.cli create-user NAME` | Create an account (it gets the default channels) |
| `... reset-password NAME` | New password; signs out every session |
| `... list-users` | List accounts |
| `... purge` | Apply the retention policy now (it also runs hourly) |
| `... migrate` | Apply database migrations |

## Configuration

Every setting is an environment variable `RELAY_*`, or goes in a `.env` file at the repo root. See `.env.example`. Production setup
is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Layout

```
backend/app/        FastAPI app: routers/ingest.py (public endpoint), hooks, channels, messages, stream (SSE), auth
backend/migrations/ Alembic migrations
backend/tests/      unit, API and live end-to-end tests
frontend/src/       React UI (components/, live.ts = SSE client, api.ts = typed client)
deploy/             Dockerfile, docker-compose.yml, Caddyfile (HTTPS)
data/               local database, uploads and server log (gitignored)
```
