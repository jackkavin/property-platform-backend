import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import hpp from 'hpp';
import sanitizeHtml from 'sanitize-html';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';

/** Sets a unique ID per request for log correlation and client-facing error traceability. */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = req.header('x-request-id') || uuidv4();
  (req as any).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * Vulnerability this fixes: Stored/Reflected XSS via unsanitized user input
 * (SECURITY_REPORT.md, VULN-01) - e.g. an enquiry "message" field containing
 * <script> tags rendered later in an admin dashboard.
 *
 * Recursively strips HTML/script content from every string in the request
 * body. We do NOT rely on output-encoding alone, since the same data may be
 * consumed by multiple downstream systems (CRM, email templates, admin UI)
 * that may not all escape consistently - so we sanitize at the boundary.
 */
export function sanitizeBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    req.body = deepSanitize(req.body);
  }
  next();
}

function deepSanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();
  }
  if (Array.isArray(value)) {
    return value.map(deepSanitize);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepSanitize(v);
    }
    return out;
  }
  return value;
}

/** helmet sets a strong baseline of security headers (CSP, HSTS, no-sniff, etc). */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
});

/** hpp guards against HTTP Parameter Pollution (e.g. ?email=a@x.com&email=b@evil.com). */
export const parameterPollutionGuard = hpp();

/**
 * CORS allow-list. Vulnerability this fixes: overly permissive CORS
 * (`Access-Control-Allow-Origin: *`) that would let any website read API
 * responses using a logged-in user's cookies/tokens.
 */
export function corsOriginValidator(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
  const allowed = env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  if (!origin || allowed.includes(origin)) {
    return callback(null, true);
  }
  callback(new Error('Not allowed by CORS'));
}
