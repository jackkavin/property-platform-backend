import { Request, Response, NextFunction } from 'express';
import { redisClient } from '../config/redis';
import { ConflictError } from './errorHandler';

/**
 * Standard "Idempotency-Key" pattern (as used by Stripe et al.).
 * The client generates a UUID per logical submission (e.g. once when the
 * enquiry form is rendered) and sends it as a header. If we've already
 * processed that key, we short-circuit and return the cached response
 * instead of creating a second row - protecting against:
 *  - double-clicks / form re-submits
 *  - network retries from flaky mobile connections
 *  - naive retry loops in third-party integrations
 *
 * This is complementary to (not a replacement for) the content-based
 * fingerprint duplicate check in enquiry.service.ts, which catches
 * duplicates even when no Idempotency-Key is sent at all.
 */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h

export function idempotencyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('Idempotency-Key');
    if (!key) return next(); // optional - not all clients send one

    const redisKey = `idempotency:${req.path}:${key}`;

    // SET NX with a short "processing" marker prevents a race where two
    // concurrent requests with the same key both pass the "not found" check
    // before either has written a result (classic TOCTOU race condition).
    const claimed = await redisClient.set(redisKey, JSON.stringify({ status: 'processing' }), 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');

    if (!claimed) {
      const existingRaw = await redisClient.get(redisKey);
      const existing = existingRaw ? JSON.parse(existingRaw) : null;

      if (existing?.status === 'processing') {
        throw new ConflictError('A request with this Idempotency-Key is already being processed.');
      }

      // Already completed - replay the original response instead of redoing work.
      return res.status(existing.statusCode).json(existing.body);
    }

    // Capture the response so we can cache it once the handler finishes.
    const originalJson = res.json.bind(res);
    (res as any).json = (body: unknown) => {
      redisClient
        .set(
          redisKey,
          JSON.stringify({ status: 'completed', statusCode: res.statusCode, body }),
          'EX',
          IDEMPOTENCY_TTL_SECONDS
        )
        .catch(() => void 0);
      return originalJson(body);
    };

    next();
  };
}
