import { Client } from '@elastic/elasticsearch';
import { config } from './config.js';
import type { Delivery } from './db.js';

const es = new Client({ node: config.es });
const index = 'emails';

export async function ensureIndex() {
  try {
    const exists = await es.indices.exists({ index });
    if (exists) return;

    await es.indices.create({
      index,
      mappings: {
        properties: {
          tenantId: { type: 'keyword' },
          status: { type: 'keyword' },
          sender: { type: 'keyword' },
          recipient: { type: 'keyword' },
          subject: { type: 'text' },
          html: { type: 'text' },
          scheduledAt: { type: 'date' },
          sentAt: { type: 'date' },
        },
      },
    });
  } catch (error) {
    console.warn('Elasticsearch unavailable', error instanceof Error ? error.message : error);
  }
}

export async function indexDelivery(delivery: Delivery) {
  try {
    await es.index({
      index,
      id: delivery.id,
      document: {
        tenantId: delivery.tenant_id,
        status: delivery.status,
        sender: delivery.sender_email,
        recipient: delivery.recipient_email,
        subject: delivery.subject,
        html: delivery.html,
        scheduledAt: delivery.scheduled_at,
        sentAt: delivery.sent_at,
      },
    });
  } catch {
    // Search is best-effort; Postgres remains the source of truth.
  }
}

export async function search(tenantId: string, query: string) {
  const result = await es.search({
    index,
    query: {
      bool: {
        filter: [{ term: { tenantId } }],
        must: query
          ? [{ multi_match: { query, fields: ['subject^2', 'sender', 'recipient', 'html'] } }]
          : [],
      },
    },
    sort: [{ scheduledAt: { order: 'desc' } }],
  });

  return result.hits.hits.map((hit) => ({
    id: hit._id,
    ...(hit._source as Record<string, unknown>),
  }));
}
