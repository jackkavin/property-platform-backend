import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Fail fast on boot if required env vars are missing/malformed, rather than
 * discovering a misconfiguration mid-request in production.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.string().default('info'),

  DB_HOST: z.string(),
  DB_PORT: z.coerce.number().default(3306),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  DB_CONNECTION_LIMIT: z.coerce.number().default(10),

  REDIS_HOST: z.string(),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  CORS_ALLOWED_ORIGINS: z.string().default(''),
  CRM_WEBHOOK_SECRET: z.string().min(8),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  ENQUIRY_RATE_LIMIT_MAX: z.coerce.number().default(5),

  WPGRAPHQL_ENDPOINT: z.string().url(),
  WPGRAPHQL_CACHE_TTL_SECONDS: z.coerce.number().default(300),

  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default('no-reply@example.com'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Intentionally verbose here (server startup / trusted logs only) -
  // never expose this level of detail in an HTTP error response.
  console.error('❌ Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
