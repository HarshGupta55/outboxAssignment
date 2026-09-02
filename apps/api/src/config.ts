import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Workspace scripts run from apps/api; load the repo-level .env explicitly.
dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
});

/** Read an environment variable as a number, falling back to `fallback`. */
function envNumber(key: string, fallback: number): number {
  return Number(process.env[key] ?? fallback);
}

export const config = {
  port: envNumber('API_PORT', 4000),

  // Data stores
  db: process.env.DATABASE_URL ?? 'postgres://outbox:outbox@localhost:5432/outbox',
  redis: process.env.REDIS_URL ?? 'redis://localhost:6379',
  es: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200',

  // Web
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',

  // Worker tuning
  concurrency: envNumber('WORKER_CONCURRENCY', 10),
  minInterval: envNumber('MIN_SEND_INTERVAL_MS', 2000),
  hourlyLimit: envNumber('MAX_EMAILS_PER_HOUR_PER_SENDER', 200),

  // Slack OAuth
  slackClientId: process.env.SLACK_CLIENT_ID,
  slackClientSecret: process.env.SLACK_CLIENT_SECRET,
  slackRedirect: process.env.SLACK_REDIRECT_URI,

  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirect:
    process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:4000/api/auth/google/callback',

  // Session
  sessionSecure: process.env.SESSION_COOKIE_SECURE === 'true',
};
