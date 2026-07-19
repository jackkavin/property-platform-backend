import { Queue } from 'bullmq';
import { queueConnection, defaultJobOptions } from './queue.config';

export interface EmailJobData {
  to: string;
  template: 'enquiry_confirmation' | 'crm_status_update';
  data: Record<string, unknown>;
}

export const emailQueue = new Queue<EmailJobData>('email', { connection: queueConnection });

/**
 * Enqueues a transactional email. Kept fully async (never sent inline on
 * the request path) because SMTP providers routinely add 200ms-2s of
 * latency per call - unacceptable to make a user's enquiry submission wait
 * on that.
 */
export async function enqueueEmail(data: EmailJobData) {
  await emailQueue.add('send-email', data, defaultJobOptions);
}
