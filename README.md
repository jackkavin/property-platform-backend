# Property Platform — Backend

A production-oriented backend for a high-traffic property platform: enquiry intake, CRM webhook integration, async processing, and a cached WordPress Headless CMS (WPGraphQL) layer.

**Stack:** Node.js + TypeScript, Express, MySQL 8, Redis (cache + BullMQ queues), Docker, PM2, Nginx.

## 1. Architecture

```
                         ┌──────────────┐
 Internet ── HTTPS ──▶   │    Nginx      │  TLS termination, edge rate-limit
                         └──────┬───────┘
                                │ proxy_pass (127.0.0.1:3000)
                                ▼
                     ┌────────────────────┐
                     │  PM2 cluster (Node) │  N instances = N CPU cores
                     │  Express API        │
                     └───────┬─────┬──────┘
                             │     │
                 ┌───────────┘     └───────────┐
                 ▼                              ▼
          ┌─────────────┐               ┌──────────────┐
          │   MySQL 8    │               │    Redis      │
          │ (enquiries,  │               │ cache / rate  │
          │ properties,  │               │ limit / queue │
          │ webhook log) │               └──────┬───────┘
          └─────────────┘                        │
                                                   ▼
                                        ┌────────────────────┐
                                        │ PM2 worker process   │
                                        │ BullMQ: crm-sync,    │
                                        │ email                │
                                        └──────────┬──────────┘
                                                     ▼
                                          (simulated) CRM / SMTP

          WordPress (Headless CMS) ──WPGraphQL──▶ wpGraphQL.service.ts
                                                    (cached, stale-while-revalidate)
```

Key design decisions:
- **API and background workers are separate processes** (`server.ts` vs `worker.ts`), so a burst of CRM-sync jobs never competes with API request handling for CPU. Scale each independently.
- **Two layers of duplicate protection**: an `Idempotency-Key` header (client-controlled, catches retries/double-clicks) and a content fingerprint with a DB `UNIQUE` constraint (catches duplicate *content* even without a key, atomically — no race condition).
- **Async-first**: CRM sync and email are queued (BullMQ/Redis) with retry + exponential backoff + a dead-letter queue. The HTTP response to `POST /api/enquiry` never waits on either.
- **Defense in depth on input**: Zod schema validation → HTML/script sanitisation → parameterised queries. Any one layer failing doesn't expose the database.

## 2. Local setup

```bash
cp .env.example .env        # fill in real values
npm install
npm run migrate             # creates DB + tables, seeds 2 sample properties
npm run dev                 # API on :3000, auto-reload
npm run worker:dev          # in a second terminal — background job processor
```

Requires local MySQL 8 and Redis 7 running (or use `docker compose up` — see [DEPLOYMENT.md](./DEPLOYMENT.md)).

## 3. API summary

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/enquiry` | Create an enquiry (rate-limited, idempotent, duplicate-checked) |
| `GET` | `/api/enquiry/:id` | Retrieve one enquiry |
| `GET` | `/api/enquiries` | Paginated list (`?page=&limit=&status=` or `?cursor=&limit=`) |
| `POST` | `/api/webhook/crm` | Inbound CRM webhook (HMAC-signed) |
| `GET` | `/api/properties` | Cached property listings from WPGraphQL |
| `GET` | `/api/properties/:slug` | Cached single property from WPGraphQL |
| `GET` | `/health` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe (checks DB + Redis) |

Full request/response examples: [API_DOCS.md](./API_DOCS.md). Importable collection: [postman/property-platform.postman_collection.json](./postman/property-platform.postman_collection.json).

## 4. Other documents in this repo

- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — VPS setup, Docker, PM2, Nginx, HTTPS, firewall, step by step
- [`SECURITY_REPORT.md`](./SECURITY_REPORT.md) — vulnerabilities found & fixed, OWASP-mapped
- [`THREAT_SCENARIOS.md`](./THREAT_SCENARIOS.md) — the 5 required attack scenarios, walked through
- [`PERFORMANCE.md`](./PERFORMANCE.md) — N+1 queries, indexing, race conditions found & fixed
- [`API_DOCS.md`](./API_DOCS.md) — full endpoint reference
- [`migrations/001_init.sql`](./migrations/001_init.sql) — database schema

## 5. Testing the async workflow

1. `POST /api/enquiry` with a valid payload → returns `201` immediately.
2. In the worker terminal, you'll see `Processing CRM sync job` then `Sending email (simulated)` logged a few hundred ms later — proving the request path didn't block on either.
3. `GET /api/enquiry/:id` a couple seconds later shows `crmRecordId` populated.

## 6. Load testing

```bash
npm run test:load   # autocannon, 50 concurrent connections, 20s, against POST /api/enquiry
```
