import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

export const connection = new Redis(config.redis, { maxRetriesPerRequest: null });

export const emailQueue = new Queue('email-delivery', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});

export async function enqueueDelivery(id: string, scheduledAt: Date) {
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  return emailQueue.add('send-email', { deliveryId: id }, { jobId: id, delay });
}
