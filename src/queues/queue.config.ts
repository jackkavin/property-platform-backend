import { Queue, QueueEvents } from 'bullmq';
import { createRedisConnection } from '../config/redis';

export const queueConnection = createRedisConnection(true);

/**
 * Default job options applied to every queue in the system:
 *  - 3 attempts with exponential backoff (1s, 2s, 4s) handles transient
 *    failures (e.g. CRM briefly unreachable) without manual intervention.
 *  - removeOnComplete keeps Redis memory bounded under high volume.
 *  - removeOnFail: false is intentional - failed jobs are inspected via the
 *    dead-letter queue below, not silently discarded.
 */
export const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
  removeOnFail: false,
};

/** Dead-letter queue: jobs that exhausted all retry attempts land here for manual review/replay. */
export const deadLetterQueue = new Queue('dead-letter', { connection: queueConnection });

export async function sendToDeadLetter(originalQueue: string, jobName: string, data: unknown, failedReason: string) {
  await deadLetterQueue.add('failed-job', {
    originalQueue,
    jobName,
    data,
    failedReason,
    failedAt: new Date().toISOString(),
  });
}

export function attachDeadLetterHandler(queueName: string, queueEvents: QueueEvents) {
  queueEvents.on('failed', async ({ jobId, failedReason }) => {
    // BullMQ already retried per defaultJobOptions.attempts before this
    // fires with a terminal failure - this is the true "gave up" case.
    await sendToDeadLetter(queueName, jobId, { jobId }, failedReason);
  });
}
