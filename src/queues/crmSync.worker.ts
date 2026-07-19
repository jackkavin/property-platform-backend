import { Worker, QueueEvents } from 'bullmq';
import { queueConnection, attachDeadLetterHandler } from './queue.config';
import { CrmSyncJobData } from './crmSync.queue';
import { pushEnquiryToCrm } from '../services/crm.service';
import { logger } from '../utils/logger';

/**
 * Processes CRM sync jobs off the main request thread.
 * Concurrency of 5 means up to 5 enquiries sync to the CRM in parallel,
 * bounded so we don't overwhelm the (simulated) third-party API.
 */
export const crmSyncWorker = new Worker<CrmSyncJobData>(
  'crm-sync',
  async (job) => {
    logger.info('Processing CRM sync job', { jobId: job.id, enquiryId: job.data.enquiryId });
    const { crmRecordId } = await pushEnquiryToCrm(job.data.enquiryId);
    logger.info('CRM sync complete', { enquiryId: job.data.enquiryId, crmRecordId });
    return { crmRecordId };
  },
  { connection: queueConnection, concurrency: 5 }
);

crmSyncWorker.on('failed', (job, err) => {
  logger.warn('CRM sync job failed (will retry per backoff policy)', {
    jobId: job?.id,
    attempt: job?.attemptsMade,
    error: err.message,
  });
});

const crmSyncQueueEvents = new QueueEvents('crm-sync', { connection: queueConnection });
attachDeadLetterHandler('crm-sync', crmSyncQueueEvents);
