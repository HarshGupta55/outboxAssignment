# Outbox Labs — persistent email scheduler

This is a production-style slice of an outbound email platform. Every request gets written to PostgreSQL, a delayed job gets queued in Redis via BullMQ, and the message gets indexed in Elasticsearch. A worker process handles actual delivery through Ethereal SMTP. Nothing here relies on cron.

## Getting it running

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
npm run dev
```

The dashboard runs at `http://localhost:5173`, and you can watch jobs move through the queue at `http://localhost:4000/admin/queues`.

### Setting up Google login

Create a Google OAuth **Web application** credential, and add `http://localhost:4000/api/auth/google/callback` as an authorized redirect URI. Drop the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

There's no mock login here — the dashboard uses the real Google authorization-code flow, stores a seven-day HTTP-only session, and shows the profile that comes back.

For SMTP, just leave the username and password blank when scheduling — the API spins up an Ethereal test account for you automatically. You can preview any sent message right from the dashboard.

## API

- `POST /api/emails` (authenticated) — takes `{ senderEmail, recipientEmail, subject, html, scheduledAt, smtpHost, smtpPort, smtpUser, smtpPass }`
- `POST /api/emails/batch` — same delivery settings, plus an `emails` array, `delaySeconds`, and `hourlyLimit`. This is what powers the lead-file compose flow.
- Add an `Idempotency-Key` header if you want to safely retry a request.
- `GET /api/emails?status=scheduled|sent` — lists emails by state
- `GET /api/emails/search?q=...` — searches Elasticsearch
- `GET /health` — reports the status of dependencies

## How it behaves under load and failure

PostgreSQL is the source of truth here, not Redis. The `idempotency_key` and the BullMQ `jobId` are both set to the delivery's UUID, so retrying an API call can't accidentally create a duplicate send.

Redis persists delayed jobs across restarts of the API or worker. On startup, a reconciliation pass checks for any scheduled rows that are missing from Redis and re-enqueues them. When the worker picks up a job, it marks the row `sending` atomically, so a row only ever gets sent once — anything already marked `sent` gets acknowledged without touching SMTP again.

Worker concurrency is controlled by `WORKER_CONCURRENCY` (default 10), and a queue limiter enforces a global minimum gap between SMTP attempts via `MIN_SEND_INTERVAL_MS` (default 2 seconds).

Hourly sending limits are enforced per sender using a Redis Lua script, so the quota check stays atomic even across multiple processes (`MAX_EMAILS_PER_HOUR_PER_SENDER`, default 200). If a sender hits their limit, the job doesn't get dropped — it just rolls forward to the next hour boundary. A one-per-window notification key also keeps Slack from getting spammed with repeat alerts, without breaking BullMQ's delayed-job ordering.

Practically, this means if you schedule 1,000 emails for the same moment, they'll sit queued in Redis rather than firing all at once. Concurrency limits how many are actively being worked on, the minimum-send interval smooths out the pace, and anything over the hourly cap just spills into the next window.

## Slack notifications

Set the Slack OAuth environment variables, and register `http://localhost:4000/api/slack/callback` as your app's redirect URL. Clicking **Connect Slack** in the dashboard kicks off a real OAuth authorization-code flow.

The backend stores the installation token and fires a `chat.postMessage` the first time a sender hits its hourly quota within a given hour. If there's no Slack installation connected, this just quietly does nothing — and reconnecting takes effect right away.

## Notes for running this for real

This repo is a demo, so a few things are simplified that you'd want to tighten up in production:

- Use TLS and a managed Postgres instance, and make sure Redis persistence is on
- Encrypt SMTP and Slack secrets at rest (right now they're stored in plain columns for clarity)
- Authenticate tenant IDs properly instead of trusting whatever's passed in the request body
- Run at least two worker replicas for redundancy
- Elasticsearch is treated as best-effort — if it's down, everything else keeps working, since PostgreSQL is what's actually authoritative
