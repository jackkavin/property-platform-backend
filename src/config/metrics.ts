import client from 'prom-client';

/**
 * Prometheus-compatible metrics. Exposed at GET /metrics (see routes/health.routes.ts).
 *
 * This is deliberately framework-agnostic output (the Prometheus exposition
 * format) rather than a proprietary dashboard, so it plugs into whatever
 * monitoring stack you actually run in production: a self-hosted
 * Prometheus + Grafana pair, or a hosted option that scrapes this same
 * endpoint (Grafana Cloud free tier, Better Stack, etc.).
 */
const register = new client.Registry();

// Default process metrics: CPU usage, memory (RSS/heap), event loop lag,
// active handles/requests, GC pauses. These alone catch a large class of
// production incidents (memory leaks, event-loop blocking) with zero
// custom instrumentation.
client.collectDefaultMetrics({ register, prefix: 'property_platform_' });

export const httpRequestDuration = new client.Histogram({
  name: 'property_platform_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labelled by method/route/status',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

export const enquiriesCreatedTotal = new client.Counter({
  name: 'property_platform_enquiries_created_total',
  help: 'Total number of successfully created enquiries',
  registers: [register],
});

export const enquiriesDuplicateTotal = new client.Counter({
  name: 'property_platform_enquiries_duplicate_total',
  help: 'Total number of enquiry submissions rejected as duplicates',
  registers: [register],
});

export const webhookEventsTotal = new client.Counter({
  name: 'property_platform_crm_webhook_events_total',
  help: 'Total CRM webhook calls received, labelled by whether the signature was valid',
  labelNames: ['signature_valid'],
  registers: [register],
});

export const rateLimitExceededTotal = new client.Counter({
  name: 'property_platform_rate_limit_exceeded_total',
  help: 'Total requests rejected by rate limiting, labelled by which limiter',
  labelNames: ['limiter'],
  registers: [register],
});

export { register as metricsRegister };
