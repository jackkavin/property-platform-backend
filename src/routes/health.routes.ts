import { Router, Request, Response } from 'express';
import { pool } from '../config/db';
import { redisClient } from '../config/redis';
import { metricsRegister } from '../config/metrics';

const router = Router();

/** Liveness: is the process up at all. Used by Docker HEALTHCHECK / PM2. */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

/** Readiness: is the process able to serve real traffic (DB + Redis reachable). Used by Nginx/load balancer. */
router.get('/health/ready', async (_req: Request, res: Response) => {
  const checks: Record<string, 'ok' | 'error'> = { database: 'ok', redis: 'ok' };

  try {
    await pool.query('SELECT 1');
  } catch {
    checks.database = 'error';
  }

  try {
    await redisClient.ping();
  } catch {
    checks.redis = 'error';
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'not_ready', checks });
});

/**
 * Prometheus scrape endpoint. Deliberately NOT behind the general API rate
 * limiter (same reasoning as /health) since a monitoring system polls this
 * frequently and must never be throttled.
 *
 * In production, don't expose this to the public internet unauthenticated -
 * restrict it at the Nginx layer to your monitoring server's IP, or put it
 * behind a separate internal-only port. See DEPLOYMENT.md.
 */
router.get('/metrics', async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', metricsRegister.contentType);
  res.send(await metricsRegister.metrics());
});

export default router;
