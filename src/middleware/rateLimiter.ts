import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
// @ts-ignore - types ship separately and lag behind the package version
import { RedisStore } from 'rate-limit-redis';
import { redisClient } from '../config/redis';
import { env } from '../config/env';
import { TooManyRequestsError } from './errorHandler';

/**
 * Vulnerability this directly fixes: "Unrestricted request volume enabling
 * brute-force / scraping / DoS" (SECURITY_REPORT.md, VULN-02) and Threat
 * Scenario 3 (flooding the API to crash the backend).
 *
 * Using a Redis-backed store (instead of the in-memory default) matters
 * because: (a) the app is deployed behind PM2 in cluster mode / multiple
 * containers, so an in-memory counter would be per-process and trivially
 * bypassed by round-robin load balancing; (b) counters must survive a
 * process restart, otherwise an attacker can force restarts to reset limits.
 */
function buildLimiter(windowMs: number, max: number, keyPrefix: string) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
      // @ts-ignore - ioredis client is compatible with the sendCommand signature
      sendCommand: (...args: string[]) => redisClient.call(...args),
      prefix: keyPrefix,
    }),
    handler: () => {
      throw new TooManyRequestsError('Too many requests. Please slow down and try again later.');
    },
    // express-rate-limit requires IPv6 addresses to go through its own
    // helper (rather than being used raw) so they're normalized to a
    // consistent subnet-level key - otherwise an IPv6 client could bypass
    // the limit entirely by requesting a new address from their own /64
    // block on every request.
    keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
  });
}

/** General limiter applied to all /api routes. */
export const generalRateLimiter = buildLimiter(env.RATE_LIMIT_WINDOW_MS, env.RATE_LIMIT_MAX, 'rl:general:');

/**
 * Tighter limiter specifically for POST /api/enquiry - the most abuse-prone
 * endpoint (Threat Scenario 1: flooding with fake enquiries).
 */
export const enquiryRateLimiter = buildLimiter(
  env.RATE_LIMIT_WINDOW_MS,
  env.ENQUIRY_RATE_LIMIT_MAX,
  'rl:enquiry:'
);

/** Limiter for the CRM webhook - external systems shouldn't need high burst rates. */
export const webhookRateLimiter = buildLimiter(env.RATE_LIMIT_WINDOW_MS, 30, 'rl:webhook:');
