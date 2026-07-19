import { Queue } from 'bullmq';
import { queueConnection, defaultJobOptions } from './queue.config';

export interface CrmSyncJobData {
  enquiryId: number;
}

export const crmSyncQueue = new Queue<CrmSyncJobData>('crm-sync', { connection: queueConnection });

/**
 * Enqueues a background job to push a new enquiry to the CRM.
 * This is the async workflow required by the task spec ("CRM sync" example).
 * Called from enquiry.service.ts right after the DB write commits - the
 * HTTP response to the user does NOT wait for this to complete.
 */
export async function enqueueCrmSync(data: CrmSyncJobData) {
  await crmSyncQueue.add('sync-enquiry', data, {
    ...defaultJobOptions,
    jobId: `crm-sync-${data.enquiryId}`, // idempotent - re-enqueuing the same enquiry is a no-op
    // Note: BullMQ uses ':' internally as a key separator in Redis and
    // rejects custom job IDs containing it - hyphen used instead.
  });
}
