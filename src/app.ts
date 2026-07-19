import express, { Application } from 'express';
import cors from 'cors';
import compression from 'compression';
import { env } from './config/env';
import { logger } from './utils/logger';
import { requestId, securityHeaders, sanitizeBody, parameterPollutionGuard, corsOriginValidator } from './middleware/security';
import { generalRateLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { httpRequestDuration } from './config/metrics';

import healthRoutes from './routes/health.routes';
import enquiryRoutes from './routes/enquiry.routes';
import webhookRoutes from './routes/webhook.routes';
import propertyRoutes from './routes/property.routes';

export function createApp(): Application {
  const app = express();

  // Required when deployed behind Nginx so req.ip reflects the real client
  // IP (from X-Forwarded-For) rather than the proxy's own address - this
  // matters directly for rate limiting and abuse-log accuracy.
  app.set('trust proxy', 1);

  app.use(requestId);

  // Times every request and records it against the Prometheus histogram,
  // labelled by the matched route pattern (not the raw URL, which would
  // create unbounded label cardinality for e.g. /api/enquiry/:id with a
  // different id on every request).
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = (req.route?.path as string) || req.path;
      httpRequestDuration.observe(
        { method: req.method, route, status_code: String(res.statusCode) },
        durationSeconds
      );
    });
    next();
  });

  app.use(securityHeaders);
  app.use(cors({ origin: corsOriginValidator, credentials: true }));
  app.use(compression());

  // Capture the raw body (needed for HMAC signature verification on the
  // webhook route) while still populating req.body as parsed JSON for
  // everyone else. 1mb cap prevents oversized-payload DoS attempts.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  app.use(parameterPollutionGuard);
  app.use(sanitizeBody);

  // Health checks are excluded from the general rate limiter - load
  // balancers / uptime monitors poll these frequently and must never be
  // throttled.
  app.use('/', healthRoutes);

  app.use('/api', generalRateLimiter);
  app.use('/api', enquiryRoutes);
  app.use('/api', webhookRoutes);
  app.use('/api', propertyRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.info(`App configured for environment: ${env.NODE_ENV}`);
  return app;
}
