import { DelayedError, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { mailAttachments } from './attachments.js';
import { config } from './config.js';
import { db, getDelivery, type Delivery } from './db.js';
import { connection, emailQueue, enqueueDelivery } from './queue.js';
import { indexDelivery } from './search.js';
import {
  createEtherealSmtp,
  createSmtpTransport,
  isEtherealHost,
  isSmtpAuthError,
} from './smtp.js';

// ---------------------------------------------------------------------------
// Rate-limit quota
// ---------------------------------------------------------------------------

/** Redis key TTL used for the per-sender hourly email quota (slightly over 1 hour). */
const QUOTA_TTL_MS = 3_700_000;

/**
 * Lua script that atomically increments a per-sender hourly counter
 * and sets a TTL on its first use.
 * Returns the new counter value.
 */
const reserveQuotaScript = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

/** Return a Date set to the top of the next clock hour. */
function nextHourBoundary(): Date {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date;
}

/**
 * Send a one-time Slack notification when a sender's hourly quota is exhausted.
 * Uses a Redis NX key to ensure only one alert is sent per sender per hour.
 */
async function notifyHourlyLimitReached(tenantId: string, senderEmail: string): Promise<void> {
  const currentHour = new Date().toISOString().slice(0, 13); // "2025-01-01T14"
  const dedupeKey = `rate-alert:${tenantId}:${senderEmail}:${currentHour}`;
  const isFirstAlert = await connection.set(dedupeKey, '1', 'PX', QUOTA_TTL_MS, 'NX');
  if (!isFirstAlert) return;

  const installation = (
    await db.query<{ access_token: string; channel_id: string | null }>(
      'select access_token, channel_id from slack_installations where tenant_id = $1',
      [tenantId],
    )
  ).rows[0];

  if (!installation?.channel_id) return;

  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${installation.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: installation.channel_id,
      text: `Outbox rate limit reached for ${senderEmail}. Remaining deliveries will resume next hour.`,
    }),
  }).catch(() => undefined); // Slack notifications are best-effort
}

// ---------------------------------------------------------------------------
// BullMQ worker
// ---------------------------------------------------------------------------

export const worker = new Worker(
  'email-delivery',
  async (job) => {
    const delivery = await getDelivery(job.data.deliveryId);

    // Skip deliveries that are already done or currently being processed.
    if (!delivery || delivery.status === 'sent') return;
    if (delivery.status === 'sending') return; // guard against duplicate processing after a crash

    // ── Hourly quota check ─────────────────────────────────────────────────
    const windowStart = new Date();
    windowStart.setMinutes(0, 0, 0);
    const quotaKey = `email-quota:${delivery.tenant_id}:${delivery.sender_email}:${windowStart.toISOString()}`;
    const currentCount = Number(
      await connection.eval(reserveQuotaScript, 1, quotaKey, QUOTA_TTL_MS),
    );

    if (currentCount > config.hourlyLimit) {
      // Roll back the quota increment and delay the job until next hour.
      await connection.decr(quotaKey);
      await notifyHourlyLimitReached(delivery.tenant_id, delivery.sender_email);
      await db.query(
        "update email_deliveries set status = 'scheduled' where id = $1 and status = 'scheduled'",
        [delivery.id],
      );
      await job.moveToDelayed(nextHourBoundary().getTime(), job.token!);
      throw new DelayedError();
    }

    // ── Claim the delivery (optimistic lock) ───────────────────────────────
    // Only proceed if the row is still in 'scheduled' state; prevents double-sends.
    const claimed = await db.query(
      "update email_deliveries set status = 'sending', error = null where id = $1 and status = 'scheduled' returning *",
      [delivery.id],
    );
    if (!claimed.rowCount) return;

    // ── Send ───────────────────────────────────────────────────────────────
    try {
      await sendDelivery(claimed.rows[0] as Delivery);
    } catch (error) {
      // Revert to 'scheduled' so the job can be retried by BullMQ.
      const message = error instanceof Error ? error.message : 'SMTP send failed';
      await db.query(
        "update email_deliveries set status = 'scheduled', error = $2 where id = $1",
        [delivery.id, message],
      );
      throw error;
    }
  },
  {
    connection,
    concurrency: config.concurrency,
    limiter: { max: 1, duration: config.minInterval },
  },
);

worker.on('failed', (job, err) => {
  console.error('delivery failed', job?.id, err.message);
});

// ---------------------------------------------------------------------------
// SMTP dispatch
// ---------------------------------------------------------------------------

/**
 * Attempt to send `delivery` via SMTP.
 * If the Ethereal credentials are stale (auth error on an Ethereal host),
 * fresh credentials are provisioned automatically and the delivery record is updated.
 */
async function sendDelivery(delivery: Delivery): Promise<void> {
  let current = delivery;

  try {
    await dispatchSmtp(current);
  } catch (error) {
    const isEtherealAuthError = isSmtpAuthError(error) && isEtherealHost(current.smtp_host);
    if (!isEtherealAuthError) throw error;

    // Regenerate Ethereal credentials and retry once.
    const smtp = await createEtherealSmtp();
    const updated = (
      await db.query<Delivery>(
        `update email_deliveries
         set smtp_host = $2, smtp_port = $3, smtp_user = $4, smtp_pass = $5
         where id = $1
         returning *`,
        [current.id, smtp.smtpHost, smtp.smtpPort, smtp.smtpUser, smtp.smtpPass],
      )
    ).rows[0];

    current = { ...current, ...updated };
    await dispatchSmtp(current);
  }
}

/**
 * Send `delivery` via nodemailer and mark it as 'sent' in the database.
 * Also indexes the updated record in Elasticsearch.
 */
async function dispatchSmtp(delivery: Delivery): Promise<void> {
  const transport = createSmtpTransport(delivery);

  const result = await transport.sendMail({
    from: delivery.sender_email,
    to: delivery.recipient_email,
    subject: delivery.subject,
    html: delivery.html,
    attachments: mailAttachments(delivery.attachments),
  });

  const previewUrl = nodemailer.getTestMessageUrl(result) || null;
  const updated = (
    await db.query(
      "update email_deliveries set status = 'sent', sent_at = now(), preview_url = $2, error = null where id = $1 returning *",
      [delivery.id, previewUrl],
    )
  ).rows[0];

  await indexDelivery(updated);
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

/**
 * Re-enqueue any deliveries that are still 'scheduled' but have no active
 * BullMQ job (e.g. after an API process restart).
 * Only looks at deliveries scheduled within the last 24 hours to avoid
 * re-processing very old rows.
 */
export async function requeueStuckDeliveries(): Promise<void> {
  const rows = (
    await db.query<Delivery>(
      "select * from email_deliveries where status = 'scheduled' and scheduled_at > now() - interval '1 day'",
    )
  ).rows;

  for (const delivery of rows) {
    const existingJob = await emailQueue.getJob(delivery.id);
    const jobState = existingJob ? await existingJob.getState() : null;

    const isTerminal = jobState === 'failed' || jobState === 'completed';
    if (existingJob && isTerminal) {
      await existingJob.remove();
    }

    if (!existingJob || isTerminal) {
      await enqueueDelivery(delivery.id, new Date(delivery.scheduled_at));
    }
  }
}
