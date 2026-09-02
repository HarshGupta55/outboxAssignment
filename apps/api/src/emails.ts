import { randomUUID } from 'node:crypto';
import type express from 'express';
import { z } from 'zod';
import { attachmentsSchema, publicAttachments } from './attachments.js';
import { requireAuth } from './auth.js';
import { db, type Delivery } from './db.js';
import { enqueueDelivery } from './queue.js';
import { indexDelivery, search } from './search.js';
import { resolveSmtp } from './smtp.js';
import type { AuthedRequest } from './types.js';

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const INSERT_DELIVERY = `
  insert into email_deliveries (
    id, tenant_id, idempotency_key, sender_email, recipient_email,
    subject, html, scheduled_at, status, smtp_host, smtp_port, smtp_user, smtp_pass,
    attachments
  )
  values ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled', $9, $10, $11, $12, $13::jsonb)
  returning *
`;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const emailRequestSchema = z.object({
  senderEmail: z.string().email(),
  recipientEmail: z.string().email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  scheduledAt: z.string().datetime(),
  smtpHost: z.string().min(1).default('smtp.ethereal.email'),
  smtpPort: z.coerce.number().int().default(587),
  smtpUser: z.string().optional().default(''),
  smtpPass: z.string().optional().default(''),
  attachments: attachmentsSchema,
});

const batchRequestSchema = emailRequestSchema
  .omit({ recipientEmail: true })
  .extend({
    emails: z.array(z.string().email()).min(1).max(1000),
    delaySeconds: z.coerce.number().min(0).max(3600).default(2),
    hourlyLimit: z.coerce.number().min(1).max(10000).optional(),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return true if the given ISO date string is more than 5 seconds in the past. */
function isInThePast(isoDate: string): boolean {
  return new Date(isoDate).getTime() < Date.now() - 5000;
}

/**
 * Strip sensitive fields from a delivery row before sending it to the client.
 * - `smtp_pass` is removed entirely.
 * - `preview_url` is nulled (only the worker knows the real preview link).
 * - Attachment content is replaced with public metadata (filename + contentType).
 */
function toClientDelivery(row: Delivery) {
  return {
    ...row,
    preview_url: null,
    smtp_pass: undefined,
    attachments: publicAttachments(row.attachments),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerEmailRoutes(app: express.Express): void {
  // ── POST /api/emails ─────────────────────────────────────────────────────
  // Schedule a single email delivery.
  app.post('/api/emails', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const input = emailRequestSchema.parse(req.body);
      const tenantId = req.user!.id;

      if (isInThePast(input.scheduledAt)) {
        return res.status(422).json({ error: 'scheduledAt must be in the future' });
      }

      // Honor idempotency: return the existing delivery if the key was already used.
      const idempotencyKey = String(req.header('Idempotency-Key') ?? randomUUID());
      const existing = (
        await db.query<Delivery>(
          'select * from email_deliveries where tenant_id = $1 and idempotency_key = $2',
          [tenantId, idempotencyKey],
        )
      ).rows[0];

      if (existing) {
        return res.status(200).json({ delivery: toClientDelivery(existing), idempotent: true });
      }

      // Persist the delivery and enqueue the job.
      const id = randomUUID();
      const scheduledAt = new Date(input.scheduledAt);
      const smtp = await resolveSmtp(input);

      const row = (
        await db.query<Delivery>(INSERT_DELIVERY, [
          id,
          tenantId,
          idempotencyKey,
          input.senderEmail,
          input.recipientEmail,
          input.subject,
          input.html,
          scheduledAt,
          smtp.smtpHost,
          smtp.smtpPort,
          smtp.smtpUser,
          smtp.smtpPass,
          JSON.stringify(input.attachments),
        ])
      ).rows[0];

      await enqueueDelivery(id, scheduledAt);
      await indexDelivery(row);
      res.status(201).json({ delivery: toClientDelivery(row) });
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/emails/batch ───────────────────────────────────────────────
  // Schedule the same email to many recipients, with optional rate limiting.
  app.post('/api/emails/batch', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const body = batchRequestSchema.parse(req.body);

      if (isInThePast(body.scheduledAt)) {
        return res.status(422).json({ error: 'Start time must be in the future' });
      }

      const rootTime = new Date(body.scheduledAt);
      const perHour = body.hourlyLimit ?? Number.MAX_SAFE_INTEGER;
      const smtp = await resolveSmtp(body);
      const created: ReturnType<typeof toClientDelivery>[] = [];

      for (const [index, recipientEmail] of body.emails.entries()) {
        // Spread recipients across hours when a rate limit is set.
        const hourOffset = Math.floor(index / perHour) * 3_600_000;
        const scheduledAt = new Date(
          rootTime.getTime() + index * body.delaySeconds * 1000 + hourOffset,
        );
        const id = randomUUID();

        const row = (
          await db.query<Delivery>(INSERT_DELIVERY, [
            id,
            req.user!.id,
            id, // use the delivery id as its own idempotency key for batch rows
            body.senderEmail,
            recipientEmail,
            body.subject,
            body.html,
            scheduledAt,
            smtp.smtpHost,
            smtp.smtpPort,
            smtp.smtpUser,
            smtp.smtpPass,
            JSON.stringify(body.attachments),
          ])
        ).rows[0];

        await enqueueDelivery(id, scheduledAt);
        await indexDelivery(row);
        created.push(toClientDelivery(row));
      }

      res.status(201).json({ deliveries: created, count: created.length });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/emails ──────────────────────────────────────────────────────
  // List deliveries for the authenticated tenant, with optional status filter.
  app.get('/api/emails', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : null;

      const rows = (
        await db.query<Delivery>(
          `select
             id, tenant_id, idempotency_key, sender_email, recipient_email, subject, html,
             scheduled_at, status, smtp_host, smtp_port, smtp_user, smtp_pass,
             sent_at, preview_url, error, created_at,
             coalesce((
               select jsonb_agg(jsonb_build_object('filename', a->>'filename', 'contentType', a->>'contentType'))
               from jsonb_array_elements(coalesce(attachments, '[]'::jsonb)) a
             ), '[]'::jsonb) as attachments
           from email_deliveries
           where tenant_id = $1
             and (
               $2::text is null
               or ($2 = 'sent' and status in ('sent', 'failed'))
               or status = $2
             )
           order by scheduled_at desc
           limit 200`,
          [req.user!.id, status],
        )
      ).rows;

      res.json({ deliveries: rows.map(toClientDelivery) });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/emails/search ───────────────────────────────────────────────
  // Full-text search over the tenant's deliveries via Elasticsearch.
  app.get('/api/emails/search', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const results = await search(req.user!.id, String(req.query.q ?? ''));
      res.json({ deliveries: results });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/emails/:id ──────────────────────────────────────────────────
  // Fetch a single delivery (for the email preview panel).
  app.get('/api/emails/:id', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const row = (
        await db.query<Delivery>(
          'select * from email_deliveries where id = $1 and tenant_id = $2',
          [req.params.id, req.user!.id],
        )
      ).rows[0];

      if (!row) {
        return res.status(404).json({ error: 'Email not found' });
      }

      // Return only the fields the preview panel needs.
      res.json({
        delivery: {
          id: row.id,
          sender_email: row.sender_email,
          recipient_email: row.recipient_email,
          subject: row.subject,
          html: row.html,
          scheduled_at: row.scheduled_at,
          sent_at: row.sent_at,
          status: row.status,
          attachments: row.attachments ?? [],
        },
      });
    } catch (error) {
      next(error);
    }
  });
}
