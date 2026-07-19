import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it uses,
 * so we keep a dedicated connection factory for queues and a separate
 * general-purpose client for caching / rate limiting.
 */
export function createRedisConnection(forBullMQ = false): Redis {
  const client = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: forBullMQ ? null : 3,
    enableReadyCheck: true,
  });

  client.on('error', (err) => logger.error('Redis connection error', { error: err.message }));
  client.on('connect', () => logger.info(`Redis connected (bullmq=${forBullMQ})`));

  return client;
}

export const redisClient = createRedisConnection(false);
