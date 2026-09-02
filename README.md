# Outbox Labs — persistent email scheduler

A production-oriented slice of an outbound-email platform. The API writes every request to PostgreSQL, enqueues a **BullMQ delayed job** in Redis, and indexes documents in Elasticsearch. The worker delivers via Ethereal SMTP. There are no cron jobs.

## Run it

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
npm run dev
```

Open `http://localhost:5173`; the live BullMQ dashboard is at `http://localhost:4000/admin/queues`.

### Google Login

Create a Google OAuth **Web application** credential and register `http://localhost:4000/api/auth/google/callback` as an authorized redirect URI. Add its client ID and secret to `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The dashboard has no mock login: it uses Google’s authorization-code flow, stores a seven-day, HTTP-only session, and displays the resulting Google profile.

For Ethereal, leave SMTP username and password blank when scheduling; the API creates a test account. Open a sent message in the dashboard to preview the delivered email.

## API

Authenticated `POST /api/emails` accepts `{ senderEmail, recipientEmail, subject, html, scheduledAt, smtpHost, smtpPort, smtpUser, smtpPass }`. `POST /api/emails/batch` accepts the same delivery settings plus an `emails` array, `delaySeconds`, and `hourlyLimit`; this is what the lead-file compose flow uses. Supply `Idempotency-Key` to safely retry a single request. `GET /api/emails?status=scheduled|sent` lists state. `GET /api/emails/search?q=...` searches Elasticsearch. `GET /health` reports dependencies.

## Reliability and load behavior

- PostgreSQL is the source of truth. `idempotency_key` and BullMQ `jobId` are the delivery UUID, so retrying an API call cannot create a second delivery/job.
- Redis persists delayed jobs across API/worker restarts. At startup a reconciliation pass re-enqueues scheduled rows absent from Redis. The worker marks a row `sending` atomically and only sends once; already-sent rows are acknowledged without SMTP.
- The BullMQ worker concurrency is `WORKER_CONCURRENCY` (default 10). A queue limiter enforces a global minimum `MIN_SEND_INTERVAL_MS` (default 2 seconds) between SMTP attempts.
- A Redis Lua operation atomically reserves the per-sender, hourly quota (`MAX_EMAILS_PER_HOUR_PER_SENDER`, default 200) across processes. When full, the job is moved to the next hour boundary; it is not dropped. A one-per-window Redis notification key prevents Slack alert storms while retaining queue ordering as far as BullMQ's delayed-job ordering permits.
- 1,000 emails due at once remain delayed/queued in Redis. Worker concurrency determines active work, the minimum-send limiter smooths delivery, and hourly overflow rolls into later windows.

## Slack notifications

Set the Slack OAuth environment variables and add `http://localhost:4000/api/slack/callback` as the redirect URL in your Slack app. The dashboard’s **Connect Slack** button begins the real OAuth authorization-code flow. The backend stores the installation token and posts a `chat.postMessage` request the first time a sender hits its hourly quota in a given hour. With no installation it safely does nothing; reconnecting takes effect immediately.

## Production notes

Use TLS/managed Postgres and Redis persistence, encrypt SMTP/Slack secrets at rest (the demo stores them in columns for clarity), authenticate tenant IDs instead of accepting them in the body, and run at least two worker replicas. Elasticsearch is intentionally best-effort for availability; PostgreSQL remains authoritative.
