# Threat Scenario Analysis

Attacker-perspective walkthrough of the 5 scenarios required by the assessment brief. Cross-references [SECURITY_REPORT.md](./SECURITY_REPORT.md) for the underlying vulnerability write-ups.

---

## Scenario 1 — "I want to flood the platform with thousands of fake enquiries using automated scripts."

**How the attack works:** A simple script loops `POST /api/enquiry` with randomized names/emails/messages, either to spam the sales team, exhaust CRM/email quota, or as a denial-of-service against the database.

**Business impact:** Polluted lead data, wasted third-party API costs (CRM, SMTP), degraded database performance from bloat, real customer enquiries buried under noise.

**How to reproduce:**
```bash
for i in $(seq 1 1000); do
  curl -s -X POST http://localhost:3000/api/enquiry -H "Content-Type: application/json" \
    -d "{\"fullName\":\"Bot $i\",\"email\":\"bot$i@spam.com\",\"propertyId\":1,\"message\":\"spam $i\"}" &
done
```

**Recommended fix (implemented):**
1. Redis-backed rate limiting: 5 enquiry submissions per IP per minute (`src/middleware/rateLimiter.ts`).
2. Nginx edge-level `limit_req_zone` rejects excess traffic before it reaches Node at all.
3. Content-fingerprint duplicate detection with a DB unique constraint (`enquiries.fingerprint`) blocks identical repeated submissions even from rotating IPs, at the database layer.
4. Recommended next step beyond this codebase: add a CAPTCHA (e.g. hCaptcha) on the public-facing form for an additional human-verification layer, and IP reputation/velocity checks at the CDN/WAF level (Cloudflare, etc.).

---

## Scenario 2 — "I want to abuse the CRM webhook endpoint to inject malicious data into the system."

**How the attack works:** The attacker discovers or guesses the `POST /api/webhook/crm` URL and sends fabricated payloads — e.g. marking arbitrary enquiries as `"converted"`, or attempting to inject a script/SQL fragment into a field that gets processed downstream.

**Business impact:** Corrupted enquiry status data, false "converted" leads skewing business reporting, potential downstream injection if the payload is later rendered/queried unsafely.

**How to reproduce:**
```bash
curl -X POST http://localhost:3000/api/webhook/crm -H "Content-Type: application/json" -d '{
  "event":"lead.status_changed","enquiryId":1,"crmRecordId":"fake","status":"converted"
}'
# No X-CRM-Signature header sent.
```

**Recommended fix (implemented):**
1. HMAC-SHA256 signature verification (`src/services/crm.service.ts:verifyWebhookSignature`) using a shared secret only the real CRM knows. Unsigned/incorrectly-signed requests get `401` and are never processed.
2. Every inbound call — valid or not — is persisted to `crm_webhook_events` with a `signature_valid` flag, so a rejected forgery attempt is still visible for security review, not silently dropped.
3. Payload is still Zod-validated (`crmWebhookSchema`) and sanitized (`sanitizeBody`) even after signature verification passes — defense in depth, since a compromised legitimate CRM credential shouldn't automatically mean full trust of payload content.
4. The webhook has its own tighter rate limit (`webhookRateLimiter`, 30/min) independent of the general API limit.

---

## Scenario 3 — "I want to overload the API with repeated requests and crash the backend."

**How the attack works:** A high-volume request flood (any endpoint, not just enquiry creation) aimed at exhausting server CPU, memory, DB connections, or the Node event loop, causing legitimate requests to time out or the process to crash (OOM).

**Business impact:** Full service outage, lost revenue, reputational damage, potential cascading failure if the DB connection pool is exhausted and starves even internal/admin tooling.

**How to reproduce:**
```bash
npx autocannon -c 500 -d 30 http://localhost:3000/api/enquiries
```

**Recommended fix (implemented):**
1. Layered rate limiting: Nginx (`limit_req_zone`, `limit_conn_zone`) → Redis-backed app-level limiter (`generalRateLimiter`) → per-endpoint stricter limiters.
2. Bounded MySQL connection pool (`DB_CONNECTION_LIMIT`, default 10) means a request flood queues (`waitForConnections: true`) rather than spawning unbounded connections that would crash MySQL itself.
3. `express.json({ limit: '1mb' })` caps request body size, preventing a payload-size-based memory exhaustion attack.
4. PM2 `cluster` mode spreads load across all CPU cores, and `max_memory_restart` auto-restarts any single worker process that leaks/balloons rather than letting it take the whole app down.
5. Graceful shutdown handling (`server.ts`) means even a forced restart under load drains in-flight requests instead of dropping them mid-write.

---

## Scenario 4 — "I want to retrieve sensitive server or environment information from API errors."

**How the attack works:** The attacker deliberately sends malformed input (bad types, SQL-like strings, huge payloads) hoping a stack trace, SQL error, file path, or dependency version leaks back in the error response — reconnaissance for a more targeted attack.

**Business impact:** Directly enables more effective follow-on attacks (e.g. knowing exact table/column names for a SQL injection attempt, or a vulnerable library version to target with a known CVE).

**How to reproduce (against an unfixed version):**
```bash
curl "http://localhost:3000/api/enquiry/not-a-number"
# A naive implementation would let the raw MySQL/driver error reach the response body.
```

**Recommended fix (implemented):**
1. `src/middleware/errorHandler.ts` centralizes all error responses. Only `AppError` instances (author-written, safe messages) are ever shown to the client; anything else returns a generic `"Something went wrong"` message.
2. Full error detail (stack trace, original message) is logged server-side only via Winston, tagged with a `requestId` that's also returned to the client — enabling support/debugging correlation without exposing internals.
3. `NODE_ENV=production` additionally suppresses the `debug` field that's present in non-production responses for local development convenience.
4. Zod validation catches malformed input (like `/not-a-number`) before it ever reaches the database layer, converting what would be a DB-level error into a clean, controlled `400 VALIDATION_ERROR`.

---

## Scenario 5 — "I want to exploit weak validation to inject malicious payloads into the database."

**How the attack works:** The attacker attempts classic SQL injection (`' OR '1'='1`) or stored XSS payloads in text fields like `message` or `fullName`, hoping either (a) a query is built via string concatenation and the SQL executes, or (b) the raw HTML/script is stored and later executes in an admin's browser.

**Business impact:** Full database compromise (SQLi) or session hijacking of internal staff (stored XSS) — among the most severe possible outcomes for this system.

**How to reproduce:**
```bash
curl -X POST http://localhost:3000/api/enquiry -H "Content-Type: application/json" -d '{
  "fullName":"Robert\"; DROP TABLE enquiries;--",
  "email":"attacker@example.com","propertyId":1,
  "message":"<script>alert(document.cookie)</script>"
}'
```

**Recommended fix (implemented):**
1. **SQL injection:** every query in the codebase uses `mysql2` named-placeholder parameterisation (`pool.query(sql, { param: value })`) — there is no string concatenation of user input into SQL anywhere in the service layer. Parameters are always sent separately from the query structure, so injected SQL syntax is treated as inert data, not executable code.
2. **XSS:** `sanitizeBody` middleware (`src/middleware/security.ts`) strips all HTML/script tags from every string field before it's validated or stored.
3. **Both:** Zod schema validation (`src/validators/enquiry.validator.ts`) rejects malformed/oversized input outright before it reaches either the sanitizer or the database, as a first line of defense.
4. This is intentionally layered (validate → sanitize → parameterise) so that no single control failing results in a successful attack.
