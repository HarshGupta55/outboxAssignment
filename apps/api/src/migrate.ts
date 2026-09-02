import { db } from './db.js';

await db.query(`
  create table if not exists email_deliveries (
    id uuid primary key,
    tenant_id text not null,
    idempotency_key text not null,
    sender_email text not null,
    recipient_email text not null,
    subject text not null,
    html text not null,
    scheduled_at timestamptz not null,
    status text not null default 'scheduled',
    smtp_host text not null,
    smtp_port integer not null,
    smtp_user text not null,
    smtp_pass text not null,
    sent_at timestamptz,
    preview_url text,
    error text,
    created_at timestamptz not null default now(),
    attachments jsonb not null default '[]'::jsonb,
    unique (tenant_id, idempotency_key)
  );

  create index if not exists email_deliveries_status_schedule_idx
    on email_deliveries (status, scheduled_at);

  create table if not exists slack_installations (
    tenant_id text primary key,
    access_token text not null,
    channel_id text,
    updated_at timestamptz not null default now()
  );
`);

await db.query(`
  create table if not exists users (
    id uuid primary key,
    google_sub text unique not null,
    name text not null,
    email text unique not null,
    avatar_url text,
    created_at timestamptz not null default now()
  );

  create table if not exists user_sessions (
    id uuid primary key,
    user_id uuid not null references users (id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  );

  create index if not exists user_sessions_user_idx on user_sessions (user_id);
`);

await db.query(`
  alter table email_deliveries
    add column if not exists attachments jsonb not null default '[]'::jsonb;

  alter table users
    add column if not exists password_hash text;
`);

console.log('Migration complete');
await db.end();
