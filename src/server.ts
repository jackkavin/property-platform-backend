import { createApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { verifyDbConnection, pool } from './config/db';
import { redisClient } from './config/redis';

async function bootstrap() {
  await verifyDbConnection();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 Server listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  /**
   * Graceful shutdown: stop accepting new connections, let in-flight
   * requests finish, then close the DB pool and Redis connection cleanly.
   * Essential under PM2/Docker, which send SIGTERM on every deploy/restart -
   * without this, in-flight enquiry submissions could be dropped mid-write.
   */
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received - starting graceful shutdown`);
    server.close(async () => {
      logger.info('HTTP server closed');
      try {
        await pool.end();
        redisClient.disconnect();
      } finally {
        process.exit(0);
      }
    });

    // Force-exit if graceful shutdown hangs (e.g. a stuck connection).
    setTimeout(() => {
      logger.error('Graceful shutdown timed out - forcing exit');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception - exiting', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  logger.error('Fatal error during startup', { error: err.message, stack: err.stack });
  process.exit(1);
});
