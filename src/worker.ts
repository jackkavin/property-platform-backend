import { logger } from './utils/logger';
import { verifyDbConnection } from './config/db';

/**
 * Dedicated worker process for background jobs (CRM sync, email).
 * Run as a SEPARATE PM2/Docker process from the API server (see
 * ecosystem.config.js) so that:
 *  - A burst of queued jobs never competes with the API's event loop for
 *    CPU, keeping API p99 latency stable under load.
 *  - The API and worker can be scaled independently (e.g. 4 API instances,
 *    2 worker instances).
 */
async function bootstrap() {
  await verifyDbConnection();

  const { crmSyncWorker } = await import('./queues/crmSync.worker');
  const { emailWorker } = await import('./queues/email.worker');

  logger.info('Background workers started (crm-sync, email)');

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received - shutting down workers gracefully`);
    await Promise.all([crmSyncWorker.close(), emailWorker.close()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('Fatal error during worker startup', { error: err.message, stack: err.stack });
  process.exit(1);
});
