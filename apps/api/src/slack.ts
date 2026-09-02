import { createHmac } from 'node:crypto';
import type express from 'express';
import { requireAuth } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import type { AuthedRequest } from './types.js';

// ---------------------------------------------------------------------------
// CSRF state helpers
// ---------------------------------------------------------------------------

/**
 * Generate a HMAC-signed state token that encodes the tenant ID.
 * Format: `"<hmac>.<base64url-tenantId>"`
 */
function buildSlackState(tenantId: string): string {
  const signature = createHmac('sha256', config.slackClientSecret ?? 'development')
    .update(tenantId)
    .digest('hex');
  return `${signature}.${Buffer.from(tenantId).toString('base64url')}`;
}

/**
 * Parse and verify a Slack OAuth state token.
 * Returns the decoded tenant ID and whether the signature is valid.
 */
function parseSlackState(raw: string): { tenantId: string; valid: boolean } {
  const [signature, encoded] = raw.split('.');
  const tenantId = Buffer.from(encoded ?? '', 'base64url').toString();
  const expected = createHmac('sha256', config.slackClientSecret ?? 'development')
    .update(tenantId)
    .digest('hex');
  return { tenantId, valid: expected === signature };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSlackRoutes(app: express.Express): void {
  // ── GET /api/slack/connect ───────────────────────────────────────────────
  // Redirect the authenticated user to Slack's OAuth consent screen.
  app.get('/api/slack/connect', requireAuth, async (req: AuthedRequest, res) => {
    if (!config.slackClientId || !config.slackRedirect) {
      return res.status(503).json({ error: 'Slack OAuth is not configured' });
    }

    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', config.slackClientId);
    url.searchParams.set('scope', 'chat:write');
    url.searchParams.set('redirect_uri', config.slackRedirect);
    url.searchParams.set('state', buildSlackState(req.user!.id));

    res.redirect(url.toString());
  });

  // ── GET /api/slack/callback ──────────────────────────────────────────────
  // Handle the redirect from Slack after the user grants access.
  app.get('/api/slack/callback', async (req, res, next) => {
    try {
      const { tenantId, valid } = parseSlackState(String(req.query.state ?? ''));
      if (!valid) {
        return res.status(400).send('Invalid Slack state');
      }

      // Exchange the authorization code for an access token.
      const response = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.slackClientId ?? '',
          client_secret: config.slackClientSecret ?? '',
          code: String(req.query.code ?? ''),
          redirect_uri: config.slackRedirect ?? '',
        }),
      });

      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        access_token?: string;
      };

      if (!data.ok) {
        return res.status(400).send(`Slack authorization failed: ${data.error}`);
      }

      // Upsert the Slack installation for this tenant.
      await db.query(
        `insert into slack_installations (tenant_id, access_token, channel_id)
         values ($1, $2, $3)
         on conflict (tenant_id) do update
           set access_token = excluded.access_token,
               channel_id   = excluded.channel_id,
               updated_at   = now()`,
        [tenantId, data.access_token, process.env.SLACK_CHANNEL_ID ?? null],
      );

      res.redirect(`${config.webOrigin}?slack=connected`);
    } catch (error) {
      next(error);
    }
  });
}
