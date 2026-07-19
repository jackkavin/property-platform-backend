# API Documentation

Base URL: `http://localhost:3000` (local) / `https://api.yourdomain.com` (production)

All responses are JSON. Successful responses: `{ "success": true, "data": ... }`. Errors: `{ "success": false, "error": { "code", "message" }, "requestId" }`.

---

## POST /api/enquiry

Create a new enquiry. Rate-limited to 5 requests/minute/IP.

**Headers**
| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | `application/json` |
| `Idempotency-Key` | Recommended | Client-generated UUID; safely retry the same submission without creating duplicates |

**Body**
```json
{
  "fullName": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+919876543210",
  "propertyId": 1,
  "message": "I'd like to schedule a viewing this weekend.",
  "source": "website"
}
```
| Field | Type | Constraints |
|---|---|---|
| `fullName` | string | 2-120 chars |
| `email` | string | valid email, max 254 chars |
| `phone` | string | optional, `[0-9+()-\s]{6,20}` |
| `propertyId` | integer | positive, must reference a published property |
| `message` | string | 1-2000 chars |
| `source` | enum | `website` \| `mobile_app` \| `partner_portal` \| `other` (default `website`) |

**201 Created**
```json
{
  "success": true,
  "data": {
    "id": 42,
    "propertyId": 1,
    "fullName": "Jane Doe",
    "email": "jane@example.com",
    "status": "new",
    "createdAt": "2026-07-18T10:15:00.000Z"
  }
}
```

**Error responses**
- `400 VALIDATION_ERROR` — malformed input (see `error.details` for field-level errors)
- `404 NOT_FOUND` — `propertyId` doesn't reference an existing/published property
- `409 CONFLICT` — duplicate enquiry (same email+phone+property+message already submitted) or duplicate `Idempotency-Key` still processing
- `429 RATE_LIMITED` — too many requests from this IP

---

## GET /api/enquiry/:id

Retrieve a single enquiry by ID.

**200 OK**
```json
{
  "success": true,
  "data": {
    "id": 42,
    "propertyId": 1,
    "propertyTitle": "3BHK Sea View Apartment - Bandra",
    "fullName": "Jane Doe",
    "email": "jane@example.com",
    "phone": "+919876543210",
    "message": "I'd like to schedule a viewing this weekend.",
    "status": "new",
    "crmRecordId": null,
    "createdAt": "2026-07-18T10:15:00.000Z"
  }
}
```
**404 NOT_FOUND** if the ID doesn't exist.

---

## GET /api/enquiries

Paginated list. Supports two pagination modes.

**Query params**
| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer | 1 | offset-mode only |
| `limit` | integer | 20 | max 100 |
| `status` | enum | — | `new` \| `contacted` \| `converted` \| `closed` |
| `cursor` | integer | — | if present, switches to cursor mode (see PERFORMANCE.md) |

**200 OK (offset mode)**
```json
{
  "success": true,
  "data": [ { "id": 42, "propertyId": 1, "propertyTitle": "...", "fullName": "...", "email": "...", "status": "new", "createdAt": "..." } ],
  "pagination": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 }
}
```

**200 OK (cursor mode, `?cursor=42&limit=20`)**
```json
{
  "success": true,
  "data": [ /* ... */ ],
  "pagination": { "nextCursor": 22, "limit": 20 }
}
```

---

## POST /api/webhook/crm

Inbound webhook called by the CRM system. Requires a valid HMAC signature.

**Headers**
| Header | Required | Description |
|---|---|---|
| `X-CRM-Signature` | Yes | `sha256=<hex hmac of raw body using CRM_WEBHOOK_SECRET>` |

**Body**
```json
{
  "event": "lead.status_changed",
  "enquiryId": 42,
  "crmRecordId": "crm_abc123",
  "status": "contacted"
}
```

**200 OK**
```json
{ "success": true, "message": "Webhook processed" }
```

**401 UNAUTHORIZED** — missing/invalid signature. **404 NOT_FOUND** — `enquiryId` doesn't exist.

**Generating a valid signature (for testing):**
```bash
BODY='{"event":"lead.status_changed","enquiryId":1,"crmRecordId":"crm_abc123","status":"contacted"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$CRM_WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST http://localhost:3000/api/webhook/crm \
  -H "Content-Type: application/json" -H "X-CRM-Signature: sha256=$SIG" -d "$BODY"
```

---

## GET /api/properties

Cached property listings sourced from the WordPress Headless CMS (WPGraphQL).

**Query params:** `first` (default 20, max 50), `after` (pagination cursor from `pageInfo.endCursor`)

**200 OK**
```json
{
  "success": true,
  "data": [ { "id": "cG9zdDoxMDE=", "databaseId": 101, "title": "...", "slug": "...", "propertyFields": { "price": 5200000, "bedrooms": 3 } } ],
  "pageInfo": { "hasNextPage": true, "endCursor": "..." }
}
```

## GET /api/properties/:slug

Single property detail. **404 NOT_FOUND** if the slug doesn't exist in the CMS. **502 CMS_UPSTREAM_ERROR** if WPGraphQL is unreachable and no cached copy is available.

---

## GET /health

Liveness probe. Always `200` if the process is running.

## GET /health/ready

Readiness probe. `200` if DB and Redis are both reachable, otherwise `503` with a `checks` breakdown.
