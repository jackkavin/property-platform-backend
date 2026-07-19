import { Router, Request, Response } from 'express';
import { pool } from '../config/db';
import { redisClient } from '../config/redis';

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

export default router;
