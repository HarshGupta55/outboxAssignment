import pg from 'pg';
import { config } from './config.js';

export const db = new pg.Pool({ connectionString: config.db });

export type Delivery = {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  sender_email: string;
  recipient_email: string;
  subject: string;
  html: string;
  scheduled_at: string;
  status: 'scheduled' | 'sending' | 'sent' | 'failed';
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass: string;
  sent_at: string | null;
  preview_url: string | null;
  error: string | null;
  created_at: string;
  attachments: { filename: string; contentType: string; content: string }[];
};

export async function getDelivery(id: string) {
  const result = await db.query<Delivery>('select * from email_deliveries where id = $1', [id]);
  return result.rows[0];
}
