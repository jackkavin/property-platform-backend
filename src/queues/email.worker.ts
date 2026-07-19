import { Worker, QueueEvents } from 'bullmq';
import { queueConnection, attachDeadLetterHandler } from './queue.config';
import { EmailJobData } from './email.queue';
import { logger } from '../utils/logger';

const templates: Record<EmailJobData['template'], (data: Record<string, unknown>) => { subject: string; body: string }> = {
  enquiry_confirmation: (data) => ({
    subject: 'We received your enquiry',
    body: `Hi ${data.fullName}, thanks for your enquiry (#${data.enquiryId}). Our team will reach out shortly.`,
  }),
  crm_status_update: (data) => ({
    subject: 'Update on your enquiry',
    body: `Hi, your enquiry status changed to "${data.status}".`,
  }),
};

/**
 * In this assessment build, "sending" is simulated (logged) instead of
 * calling a real SMTP provider, to keep the deliverable runnable without
 * live third-party credentials. Swapping in nodemailer/SES/SendGrid here
 * is a one-function change - the queue/retry/backoff scaffolding around it
 * does not need to change.
 */
export const emailWorker = new Worker<EmailJobData>(
  'email',
  async (job) => {
    const { subject, body } = templates[job.data.template](job.data.data);
    logger.info('Sending email (simulated)', { to: job.data.to, subject });
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (Math.random() < 0.05) throw new Error('Simulated SMTP timeout');
    return { subject, body };
  },
  { connection: queueConnection, concurrency: 10 }
);

emailWorker.on('failed', (job, err) => {
  logger.warn('Email job failed (will retry per backoff policy)', { jobId: job?.id, error: err.message });
});

const emailQueueEvents = new QueueEvents('email', { connection: queueConnection });
attachDeadLetterHandler('email', emailQueueEvents);
