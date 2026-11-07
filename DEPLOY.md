# Deploying Berpal

One Node process serves the Twilio webhook and runs the daily job scheduler; Postgres holds identity, conversation state, caches and job/outreach logs. ERPNext, Twilio and OpenAI are external services. Nothing here sets values: every `<...>` is yours to fill in.

## Prerequisites

- Node 26 (the image uses `node:26-alpine`; the code needs 20.3+) or Docker 24+
- Postgres 14+ (Compose ships 16)
- An ERPNext site reachable from the server, with the Companies set up as in README → ERPNext setup
- A Twilio account with a WhatsApp sender (or the Sandbox), and the confirmation template (`npm run create-template`)
- An OpenAI API key
- A public **https** origin for the server (Fly/Railway give you one; otherwise a reverse proxy or tunnel)

## Environment checklist

Every variable is documented in [.env.example](.env.example). The server validates them at boot (`src/config.js`) and exits with one line per problem; run the same check any time with:

```bash
npm run check:env          # reads .env + the process environment
```

| Always required | Notes |
|---|---|
| `DATABASE_URL` | See the SSL note below |
| `OPENAI_API_KEY` | |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | |
| `ERPNEXT_URL` | http(s); a trailing slash is stripped |
| Sender for `TWILIO_ENV` | `sandbox` → `TWILIO_WHATSAPP_NUMBER_SANDBOX`, `live` → `TWILIO_WHATSAPP_NUMBER_LIVE`; either falls back to the legacy `TWILIO_WHATSAPP_NUMBER`. In live mode `src/twilio-client.js` would send from `TWILIO_WHATSAPP_NUMBER_SANDBOX` before the legacy number, so live without `*_LIVE` is refused while `*_SANDBOX` is set. `TWILIO_ENV` must be exactly `sandbox`/`live` (case-insensitive, no spaces). |

| Also required with `NODE_ENV=production` (the image default) | |
|---|---|
| `PUBLIC_BASE_URL` (or `TWILIO_WEBHOOK_URL`), https | Signs/validates `/webhook` and `/twilio/status`. Set `PUBLIC_BASE_URL` even if you use `TWILIO_WEBHOOK_URL`, or status callbacks are refused. |
| `TWILIO_CONFIRMATION_CONTENT_SID` | |
| `LOG_MESSAGES` not `true` | Retention policy: no chat logs |
| `SEED_TEST_USER_PHONE` unset | It seeds a test user on every boot |

Warnings only (features degrade): `TWILIO_DIGEST_CONTENT_SID`, `TWILIO_INVOICE_CONTENT_SID`, `TWILIO_REMINDER_CONTENT_SID` (without them those sends only reach users inside WhatsApp's 24h window; see README), `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` (only the seeded user and `scripts/` use them). An invalid `MEDIA_MAX_BYTES` stops the boot from `src/media/download.js`.

**Postgres SSL.** `src/db.js` connects with SSL to every host except `*.railway.internal`. For a database without TLS (Compose, Fly's internal `.flycast` Postgres) add `?sslmode=disable` to `DATABASE_URL`; the connection string wins over the code's default.

## First boot

```bash
npm ci
cp .env.example .env      # fill in; leave NODE_ENV unset for local dev
npm run check:env
npm start
curl -s localhost:3000/health | jq
```

Migrations apply themselves: `db.init()` runs the core schema and every `src/migrations/*.sql` (idempotent, filename order) on each boot. `node scripts/migrate.js` does the same without starting the server.

## Docker Compose (single host)

`docker-compose.yml` runs Postgres 16 (volume `pgdata`) and the app; ERPNext stays external. Compose overrides `DATABASE_URL` to point at its own `db` service.

```bash
cp .env.example .env      # fill in; set POSTGRES_PASSWORD in your shell or .env for a non-default password
npm run docker:up         # docker compose up --build -d
npm run docker:logs
curl -s localhost:3000/health
npm run docker:down
```

The image defaults to `NODE_ENV=production`, and a fresh copy of `.env.example` fails its checks (`LOG_MESSAGES=true`, `SEED_TEST_USER_PHONE` set, no `PUBLIC_BASE_URL`): the container exits at boot and restarts in a loop until you fix what `npm run docker:logs` lists under `[config]`, or set `NODE_ENV=development` in `.env` for a sandbox/ngrok run. The same applies to a bare `docker run` of the image. Compose pins `PORT=3000` inside the container to match the port mapping. Put an https reverse proxy (Caddy, nginx, a tunnel) in front and set `PUBLIC_BASE_URL` to its origin.

## Fly.io

```bash
fly launch --no-deploy                       # detects the Dockerfile, writes fly.toml; pick a region near ERPNext
fly postgres create --name berpal-db         # or: fly mpg create (Managed Postgres)
fly postgres attach berpal-db                # sets the DATABASE_URL secret; make sure it ends with ?sslmode=disable
fly secrets set OPENAI_API_KEY=<...> TWILIO_ACCOUNT_SID=<...> TWILIO_AUTH_TOKEN=<...> \
  ERPNEXT_URL=<...> TWILIO_ENV=live TWILIO_WHATSAPP_NUMBER_LIVE=<whatsapp:+...> \
  TWILIO_CONFIRMATION_CONTENT_SID=<HX...> PUBLIC_BASE_URL=https://<app>.fly.dev
fly secrets set TWILIO_DIGEST_CONTENT_SID=<HX...> TWILIO_INVOICE_CONTENT_SID=<HX...> TWILIO_REMINDER_CONTENT_SID=<HX...>
```

In `fly.toml`, keep exactly one machine always running (the scheduler lives in the web process, so a stopped machine sends no digests) and probe the shallow health check:

```toml
[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/health?deep=0"
    interval = "30s"
    timeout = "5s"
    grace_period = "30s"
```

```bash
fly deploy
fly scale count 1
fly logs
fly ssh console -C "node scripts/migrate.js"   # optional; boot already migrates
```

## Railway

```bash
railway init                                  # or railway link to an existing project
railway add --database postgres
railway add --service berpal                  # empty app service; variables go on it before the first deploy
railway service berpal                        # link the CLI to it (variables/up/logs target the linked service)
railway variables --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}'   # internal URL → SSL off automatically
railway variables --set "OPENAI_API_KEY=<...>" --set "TWILIO_ACCOUNT_SID=<...>" --set "TWILIO_AUTH_TOKEN=<...>" \
  --set "ERPNEXT_URL=<...>" --set "TWILIO_ENV=live" --set "TWILIO_WHATSAPP_NUMBER_LIVE=<whatsapp:+...>" \
  --set "TWILIO_CONFIRMATION_CONTENT_SID=<HX...>"
railway domain                                # generates https://<service>.up.railway.app
railway variables --set "PUBLIC_BASE_URL=https://<service>.up.railway.app"
railway up --detach                           # builds the Dockerfile and deploys
railway logs
```

In the service's Settings → Deploy set the healthcheck path to `/health?deep=0` (Railway uses it to gate each deploy) and keep one replica.

## Twilio

With `PUBLIC_BASE_URL=https://bot.example.com`:

| Twilio setting | Value |
|---|---|
| WhatsApp sender (or Sandbox settings) → "When a message comes in" | `https://bot.example.com/webhook`, HTTP POST |
| Same sender → Status callback URL | `https://bot.example.com/twilio/status` |

The signature is checked against that exact URL (scheme, host, path): if Twilio calls a different URL for inbound messages, set `TWILIO_WEBHOOK_URL` to it. A mismatch shows as `rejected: invalid X-Twilio-Signature` in the logs and a 403 in Twilio's debugger. Template and media sends request the status callback themselves when `PUBLIC_BASE_URL` is set; plain text replies only get it from the sender setting above.

## A second, web-only instance

Set `DISABLE_JOBS=1` (or `true`/`yes`/`on`) on every instance except one; `/health` then reports `scheduler.running: false` there. `job_runs` prevents double sends even if two instances run jobs. Caveat (README → Known limitations): the per-sender message queue is in memory, so two web instances can process two messages from the same user at once. Use sticky routing by sender, or keep one web instance and use the second only as a standby.

## Health check

`GET /health` → `{ status, uptime_s, version, checks: { db, erpnext, twilio, scheduler } }`

| `status` | HTTP | Meaning |
|---|---|---|
| `ok` | 200 | db `SELECT 1`, ERPNext `GET /api/method/ping`, Twilio account fetch all passed |
| `degraded` | 200 | db fine; ERPNext or Twilio failing or unconfigured: messages may fail, restarting won't help |
| `fail` | 503 | db unreachable |

Each external check has a 3s timeout (the request is aborted, not just abandoned). `?deep=0` skips ERPNext and Twilio (reported `{ ok: true, skipped: true }`); use it for platform probes and the Docker `HEALTHCHECK`, and point an external uptime monitor at the deep URL every few minutes. `/health` is unauthenticated, so deep results are cached for 30s and shared by concurrent callers: however often it is hit, it makes at most one Twilio API request and one ERPNext ping per 30s. Responses never include credentials, hostnames or upstream bodies; ERPNext failures show only `HTTP <code>`, `timeout` or `unreachable`, and the full error text for db, ERPNext and Twilio goes to the log. The response does show `version`, `uptime_s` and whether this instance runs the scheduler.

## Logs and retention

- `LOG_MESSAGES` must stay off in production (the boot refuses `true`), so the `messages` table stays empty. Each conversation still keeps its last few turns (`conversations.recent_messages`) as model context; it's cleared after a save and by `npm run reset`.
- Logs go to stdout. They carry timings, tool names and errors, and error text from ERPNext or OpenAI can include business data; set the platform's log retention to what your privacy policy allows.
- Receipt images wait in Postgres until attached to the ERPNext document (unattached ones are dropped after 7 days); public outreach files in ERPNext are deleted by the nightly `cleanup` job about 2 days after sending.

## Backups

Postgres holds no accounting truth (that's ERPNext), but it holds users, their ERPNext API credentials, contacts and conversation state. Treat dumps as secrets.

```bash
pg_dump -Fc "$DATABASE_URL" > berpal-$(date +%F).dump                     # any host
docker compose exec -T db pg_dump -U berpal -Fc berpal > berpal-$(date +%F).dump   # Compose
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" berpal-YYYY-MM-DD.dump
```

Fly Postgres and Railway also take volume snapshots; a `pg_dump` before every upgrade is still the cheap insurance. Back up ERPNext separately (`bench backup`).

## Upgrading

1. `npm test` and `node scripts/check-load.js` locally.
2. `pg_dump` (above).
3. Deploy (`fly deploy`, `railway up`, or `docker compose up --build -d`). Migrations run on boot; the new process won't listen until they're done.
4. Check `/health` (deep) and the logs for `[config]` lines.

SIGTERM lets an in-flight scheduler tick finish (max 10s), so a deploy mid-digest records its `job_runs` rows. Jobs don't catch up: a deploy that keeps the server down across a job's window skips that day's run.

## Rollback

- Fly: `fly releases --image`, then `fly deploy --image <previous image ref>`.
- Railway: Deployments → previous deployment → Redeploy.
- Compose: rebuild from the previous commit, or keep the previous image tagged (`docker tag berpal berpal:prev`) and run it.

Migrations are additive (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), so the previous release normally runs on the newer schema. If a release notes a one-off schema change, restore the pre-upgrade dump instead.
