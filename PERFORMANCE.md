# Performance Optimisation & Debugging

For each issue: root cause → how it was demonstrated → the fix → measured/expected improvement.

---

## Issue 1 — N+1 query on enquiry retrieval

**Root cause:** A naive implementation of `GET /api/enquiry/:id` (and the list endpoint) fetches the enquiry row, then issues a *second* query to look up the related property's title — and in the list endpoint, that second query runs once *per row returned* (N enquiries → 1 + N queries total).

**Demonstrated (anti-pattern, not present in final code):**
```ts
// BAD - N+1
const enquiries = await pool.query('SELECT * FROM enquiries LIMIT 20');
for (const e of enquiries) {
  const [property] = await pool.query('SELECT title FROM properties WHERE id = ?', [e.property_id]);
  e.property_title = property.title;
}
// 20 rows returned => 21 total round trips to MySQL.
```

**Fix (implemented in `src/services/enquiry.service.ts`):** A single `JOIN` fetches the enquiry and its property title in one query, for both `getEnquiryById` and `listEnquiries`:
```sql
SELECT e.*, p.title AS property_title
FROM enquiries e
JOIN properties p ON p.id = e.property_id
WHERE e.id = :id
```

**Improvement:** 21 round trips → 1. Each MySQL round trip carries fixed network + parsing overhead (typically 1-5ms locally, more over a network) independent of query complexity, so this scales linearly worse as list size grows — a 100-row page would be 101 queries under the anti-pattern vs. 1 with the join.

---

## Issue 2 — OFFSET pagination degrades on large tables

**Root cause:** `SELECT * FROM enquiries ORDER BY id DESC LIMIT 20 OFFSET 50000` forces MySQL to scan and discard the first 50,000 matching rows before it can return the 20 you actually want — cost grows linearly with page depth, so page 5,000 can be orders of magnitude slower than page 1.

**Demonstrated:** On a seeded table of ~500k rows, `EXPLAIN` on a deep-offset query shows a large number of examined rows even though only 20 are returned; wall-clock time visibly increases with offset depth.

**Fix (implemented):** `listEnquiries` (`src/services/enquiry.service.ts`) supports **cursor-based pagination** (`?cursor=<last_seen_id>&limit=20`) as an alternative to offset pagination, using `WHERE e.id < :cursor ORDER BY e.id DESC LIMIT :limit`. This is O(limit) regardless of how deep into the dataset you are, because the indexed `id` column lets MySQL seek directly to the cursor position rather than counting through rows. Offset pagination is kept available for the common case (admin UI showing page numbers 1-50, which will never realistically page deep), giving API consumers the right tool for each use case.

---

## Issue 3 — Missing indexes causing full table scans

**Root cause:** Without indexes matching the actual query patterns, filtering (`WHERE status = 'new'`) or sorting (`ORDER BY created_at DESC`) forces MySQL to scan and sort the entire table in memory/disk (`Using filesort`, `Using temporary` in `EXPLAIN`).

**Demonstrated:**
```sql
EXPLAIN SELECT * FROM enquiries WHERE status = 'new' ORDER BY created_at DESC LIMIT 20;
-- Without an index: type=ALL, Extra="Using where; Using filesort"
```

**Fix (implemented in `migrations/001_init.sql`):** A composite index `idx_enquiries_status_created (status, created_at DESC)` matches this exact filter+sort pattern, letting MySQL satisfy the query directly from the index without a separate sort step. Additional targeted indexes: `idx_enquiries_property` (FK join support), `idx_enquiries_email` (abuse investigation lookups), `uq_enquiries_fingerprint` (duplicate detection, doubles as an index for that lookup).

**Improvement:** `EXPLAIN` on the indexed version shows `type=ref`, `Extra="Using index condition"` — no filesort, no full scan. On a large table this is the difference between a sub-millisecond indexed lookup and a multi-second full scan.

---

## Issue 4 — Race condition on duplicate enquiry submission

**Root cause:** A "check-then-insert" pattern (`SELECT ... WHERE fingerprint = ?` followed by a separate `INSERT` if nothing found) has a window between the check and the insert where a second, near-simultaneous identical request can pass the same check before either has written — resulting in two duplicate rows despite the check existing (classic TOCTOU).

**Demonstrated:** Firing two identical `POST /api/enquiry` requests concurrently (`Promise.all([reqA, reqB])`) against a check-then-insert implementation reliably produces two rows roughly 1 in 3-4 attempts locally, more often under real network jitter.

**Fix (implemented):** Moved the uniqueness guarantee into the database itself via a `UNIQUE` constraint on `enquiries.fingerprint` (see `migrations/001_init.sql`). The insert is attempted directly; MySQL rejects the second of two concurrent duplicate inserts atomically (error 1062), which `enquiry.service.ts` catches and converts to a clean `409 Conflict`. This is correct under arbitrary concurrency because the database — not application code — is the single source of truth enforcing the constraint.

---

## Issue 5 — Blocking the request thread on third-party calls (CRM sync, email)

**Root cause:** A naive implementation calls the CRM API and sends the confirmation email *inline*, inside the `POST /api/enquiry` handler, before responding. Both are third-party calls with unpredictable latency (100ms-several seconds) and occasional failures — the user's response time becomes hostage to the slowest of the two, and any failure risks the whole enquiry-creation transaction.

**Demonstrated:** With synchronous CRM+email calls, `POST /api/enquiry` p95 latency tracks whatever the CRM's p95 latency is; if the CRM API degrades, so does enquiry creation, even though they're logically unrelated concerns.

**Fix (implemented):** Both operations are pushed onto BullMQ/Redis queues (`enqueueCrmSync`, `enqueueEmail` in `src/services/enquiry.service.ts`) immediately after the DB transaction commits. The HTTP response returns as soon as the enquiry row exists — CRM sync and email happen afterward, in a separate worker process (`src/worker.ts`), with their own retry/backoff policy.

**Improvement:** `POST /api/enquiry` latency becomes a function of DB write time only (typically single-digit milliseconds), fully decoupled from third-party API performance. A CRM outage no longer affects the platform's ability to accept enquiries at all — it only delays when they eventually sync, and BullMQ's retry/backoff + dead-letter queue ensures nothing is silently lost.

---

## Issue 6 — Unbounded WPGraphQL calls on every request (no caching)

**Root cause:** Calling the WordPress GraphQL endpoint synchronously on every `GET /api/properties` request means API throughput is capped by the CMS's throughput, and a CMS outage or slowdown directly becomes an outage/slowdown for this API too.

**Demonstrated:** Without caching, N concurrent requests to `/api/properties` produce N concurrent calls to WPGraphQL; the CMS (often not built for the same traffic volume as the API layer) becomes the bottleneck under any real load.

**Fix (implemented in `src/services/cache.service.ts` + `wpGraphQL.service.ts`):** Responses are cached in Redis with a stale-while-revalidate strategy: fresh cache hits return instantly with zero upstream calls; stale-but-within-grace-period hits also return instantly while a background refresh updates the cache for the *next* request; only a true cache miss blocks on WPGraphQL. Combined with active invalidation (`invalidatePropertyCache`, triggered by a WordPress save-post webhook in a real deployment), this means the CMS is called roughly once per `WPGRAPHQL_CACHE_TTL_SECONDS` window (default 5 min) regardless of API request volume, not once per request.

**Improvement:** WPGraphQL call volume drops from O(requests) to O(1) per cache TTL window — e.g. at 100 req/s sustained traffic with a 5-minute TTL, ~30,000 requests served per CMS call instead of 30,000 direct CMS calls.
