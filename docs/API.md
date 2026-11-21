# Temp Mail API Reference — turjaun.xyz

> **Service:** Temp Mail (disposable / temporary email on `turjaun.xyz`)
> **Base URL (live):** `https://temp-mail.turjaun.workers.dev`
> **API version covered:** v1 (live) + v2 additions
> **Format:** JSON only. Every API response has `Content-Type: application/json`
> and `Access-Control-Allow-Origin: *`.
> **Source of truth for v1 shapes:** `src/worker-v1-baseline.js` — every v1 example
> in this document is taken from that code, including its quirks. v2 behaviour is
> tagged **[v2]** everywhere it differs from, or extends, v1.

---

## Table of contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Endpoints](#endpoints)
  - [GET /api/health](#get-apihealth)
  - [GET /api/config](#get-apiconfig)
  - [GET /api/domains](#get-apidomains)
  - [POST /api/new_address](#post-apinew_address)
  - [GET /api/mails](#get-apimails)
  - [GET /api/inboxes/:address/messages](#get-apiinboxesaddressmessages)
  - [GET /api/mail/:id](#get-apimailid)
  - [DELETE /api/mail/:id](#delete-apimailid)
  - [GET /api/wait](#get-apiwait--v2)
- [Pagination — offset vs cursor](#pagination--offset-vs-cursor)
- [Caching / ETag](#caching--etag)
- [Rate limits & polling etiquette](#rate-limits--polling-etiquette)
- [Errors](#errors)
- [OpenAPI-style spec](#openapi-style-spec)
- [Changelog v1 → v2](#changelog-v1--v2)

---

## Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://temp-mail.turjaun.workers.dev` — all paths below are relative to it. |
| Request bodies | JSON, sent with `Content-Type: application/json`. |
| Mail / address IDs | Integers, monotonically increasing. A larger mail `id` is always a newer mail. This is what makes cursor pagination and long-polling possible. |
| `created_at`, `expires_at` | **Unix seconds** (not milliseconds). JavaScript: `new Date(created_at * 1000)`. |
| `time` (health only) | ISO 8601 string, e.g. `2026-11-21T12:29:13.646Z`. This is the one exception to the Unix-seconds rule. |
| Address casing | Addresses are lower-cased server-side. `Test123@TURJAUN.XYZ` and `test123@turjaun.xyz` are the same inbox. |
| Address local part | On create, the name is lower-cased and every character except `a–z 0–9 . _ -` is stripped. |
| Mail retention | Mails and addresses are deleted after `MAIL_TTL_HOURS` (live value: `24`, see `GET /api/config`). Do not treat an inbox as permanent storage. |
| OTP field | Where present, `otp` is the **first** sequence of 4–8 digits found in `text_body` followed by `subject`, or `null` if there is none. It is a convenience extraction, not a guarantee — always fall back to showing the full mail. |
| CORS preflight | `OPTIONS` on any path returns `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS` and `Access-Control-Allow-Headers: Authorization, Content-Type`. |
| Unknown paths | Any unmatched route returns `404` with `{"error":"Not found","path":"<path>"}` — see [Errors](#errors). |

### Endpoint index

| Method | Path | Auth | Since | Purpose |
|---|---|---|---|---|
| `GET` | `/api/health` | None | v1 | Liveness / smoke test |
| `GET` | `/api/config` | None | v1 | Domains + retention config |
| `GET` | `/api/domains` | None | v1 | Alias of `/api/config` (identical response in v1) |
| `POST` | `/api/new_address` | None | v1 | Create (or re-claim) an inbox, returns its token |
| `GET` | `/api/mails` | Bearer token | v1, cursor params **[v2]** | List mails for the token's inbox (preview shape) |
| `GET` | `/api/inboxes/:address/messages` | None (address is the capability) | v1 | List full mails for any address |
| `GET` | `/api/mail/:id` | None | v1 | Fetch one mail in full, with `otp` |
| `DELETE` | `/api/mail/:id` | None in v1 (send Bearer anyway) | v1 | Delete one mail |
| `GET` | `/api/wait` | Bearer token **or** `address` | **[v2]** | Long-poll: block until a new mail arrives or timeout |

---

## Authentication

Temp Mail uses a **per-inbox bearer token**. There are no user accounts, no
passwords, and no OAuth.

### Getting a token

Call `POST /api/new_address`. The response contains the token **twice**:

```json
{
  "address": "test123@turjaun.xyz",
  "token": "113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62",
  "jwt": "113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62",
  "expires_at": 1795350561
}
```

- `token` and `jwt` are **the same value** in v1 (the `jwt` field is a legacy
  alias kept for older clients). Despite the name it is **not** a signed JWT —
  it is an opaque 64-character hex string (32 cryptographically random bytes).
  Do not try to decode or verify it client-side.
- One token maps to exactly **one** address. It cannot read any other inbox
  through `GET /api/mails` or `GET /api/wait`.
- **Store the token when you create the inbox.** It is the only credential.

### Re-claiming a token

If you `POST /api/new_address` again with the name of an address that already
exists, v1 returns the **existing** token instead of creating a duplicate:

```json
{
  "address": "test123@turjaun.xyz",
  "token": "113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62",
  "reused": true
}
```

Note the reused response has **no** `jwt` and **no** `expires_at` field.
Clients must not require those fields on a create response.

### Sending the token

Preferred — `Authorization` header:

```http
GET /api/mails HTTP/1.1
Host: temp-mail.turjaun.workers.dev
Authorization: Bearer 113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62
```

Accepted fallback (v1) — `token` query parameter:

```http
GET /api/mails?token=113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62
```

> ⚠️ Prefer the header. Query-string tokens end up in browser history, proxy
> logs, and analytics. The query form exists for quick `curl` debugging and
> for clients that cannot set headers.

### Auth failures

Both a missing token and a token that does not match any address return the
**same** response — the API does not distinguish them:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{ "error": "Unauthorized" }
```

### Which endpoints need auth?

| Endpoint | Auth in v1 |
|---|---|
| `GET /api/health`, `GET /api/config`, `GET /api/domains`, `POST /api/new_address` | None |
| `GET /api/mails` | **Bearer token required** |
| `GET /api/wait` **[v2]** | Bearer token **or** `address` parameter (see its section) |
| `GET /api/inboxes/:address/messages` | None — **the address itself is the capability** |
| `GET /api/mail/:id`, `DELETE /api/mail/:id` | None in v1 |

> ⚠️ **Address-as-capability warning (v1 behaviour, unchanged in v2):**
> anyone who knows or guesses an address can read its full mail through
> `GET /api/inboxes/:address/messages`, and anyone who knows a mail `id` can
> read or delete it through `/api/mail/:id`. Temp-mail addresses are for
> disposable, low-sensitivity mail (sign-up confirmations, OTPs for throwaway
> accounts). Do not route mail you would not want a stranger to read if they
> guessed the address. Use random local parts (the default) rather than
> predictable names for anything even slightly sensitive.

### Token lifetime

A token lives as long as its address record. Addresses expire at
`expires_at` (creation time + `MAIL_TTL_HOURS`) and are removed by the hourly
cleanup; after that the token returns `401`. There is no refresh or revoke
endpoint in v1 or v2 — to "log out", delete the token client-side and let the
address expire, or just create a fresh random address.

---
## Endpoints

### GET /api/health

Liveness check. The cheapest possible smoke test — if this does not return
`"ok":true`, the service is down and nothing else will work.

| Item | Value |
|---|---|
| Method / path | `GET /api/health` |
| Auth | None |
| Query / body params | None |
| Success status | `200` |
| Cache | `Cache-Control: no-store` **[v2]** — never cache a liveness result |

**Success response**

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "ok": true,
  "service": "temp-mail",
  "domain": ["turjaun.xyz"],
  "time": "2026-11-21T12:29:13.646Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `ok` | boolean | Always `true` on success. |
| `service` | string | Always `"temp-mail"`. |
| `domain` | string[] | Note: singular key `domain` here — unlike `/api/config`, which uses `domains`. Exact v1 shape; do not "fix" it client-side. |
| `time` | string | Server time, ISO 8601 UTC. |

**Error example** — only the generic failure modes apply (service down is a
connection error / `5xx` from the platform, not a JSON body):

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{ "error": "Not found", "path": "/api/healthz" }
```

*(Example shows a mistyped path — `/api/healthz` — hitting the catch-all 404.)*

**Example**

```bash
curl -s https://temp-mail.turjaun.workers.dev/api/health
```

---

### GET /api/config

Returns the public configuration: which domains this service accepts mail
for, and how long mail is kept.

| Item | Value |
|---|---|
| Method / path | `GET /api/config` |
| Auth | None |
| Query / body params | None |
| Success status | `200` |
| Cache | ETag supported **[v2]** — see [Caching / ETag](#caching--etag) |

**Success response**

```json
{
  "domains": ["turjaun.xyz"],
  "ttl_hours": 24
}
```

| Field | Type | Notes |
|---|---|---|
| `domains` | string[] | All domains accepted by `POST /api/new_address` and by inbound mail. Live value: `["turjaun.xyz"]`. |
| `ttl_hours` | integer | Retention in hours, from the `MAIL_TTL_HOURS` setting. Live value: `24`. |

**Error example**

```json
{ "error": "Not found", "path": "/api/configs" }
```

*(Status `404`; again only reachable via a wrong path — the endpoint itself
takes no input and has no endpoint-specific error.)*

**Example**

```bash
curl -s https://temp-mail.turjaun.workers.dev/api/config
```

---

### GET /api/domains

Alias of `GET /api/config`.

| Item | Value |
|---|---|
| Method / path | `GET /api/domains` |
| Auth | None |
| Query / body params | None |
| Success status | `200` |

In **v1 both paths run the same handler and return the identical body**,
including `ttl_hours` — the name suggests domains-only, the body is not:

**Success response**

```json
{
  "domains": ["turjaun.xyz"],
  "ttl_hours": 24
}
```

**Error example**

```json
{ "error": "Not found", "path": "/api/domain" }
```

*(Status `404`, mistyped path.)*

**Example**

```bash
curl -s https://temp-mail.turjaun.workers.dev/api/domains
```

> New clients should call `/api/config` and treat `/api/domains` as a
> backwards-compatibility alias.

---

### POST /api/new_address

Creates a disposable inbox and returns its address and token. If the address
already exists, returns the existing inbox instead (see `reused` below).

| Item | Value |
|---|---|
| Method / path | `POST /api/new_address` |
| Auth | None — this call **issues** the credential |
| Content-Type | `application/json` |
| Success status | `200` (v1 returns `200`, not `201`, for both create and reuse) |
| Cache | Never cached |

**Request body params**

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | string | No | Random 10 chars from `a–z0–9` | Desired local part. Lower-cased; characters other than `a–z 0–9 . _ -` are stripped server-side. |
| `domain` | string | No | First configured domain (`turjaun.xyz`) | Must be one of the domains from `GET /api/config`, otherwise `400`. |

Both fields are optional — an empty body, or even a malformed JSON body
(v1 ignores body parse errors), creates a random address on the default
domain:

```bash
curl -s -X POST https://temp-mail.turjaun.workers.dev/api/new_address \
  -H "Content-Type: application/json" -d '{}'
```

**Success response — new inbox**

```json
{
  "address": "test123@turjaun.xyz",
  "token": "113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62",
  "jwt": "113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62",
  "expires_at": 1795350561
}
```

| Field | Type | Notes |
|---|---|---|
| `address` | string | The full inbox address, `<name>@<domain>`. |
| `token` | string | 64-char hex bearer token for this inbox. Store it now. |
| `jwt` | string | Legacy alias, always identical to `token` on a fresh create. |
| `expires_at` | integer | Unix seconds when the address (and its token) expire. |

**Success response — existing inbox (`reused`)**

```json
{
  "address": "test123@turjaun.xyz",
  "token": "113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62",
  "reused": true
}
```

Note: no `jwt`, no `expires_at` in this shape. Treat `reused` as success.

**Error — invalid domain (`400`)**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": "Invalid domain",
  "allowed": ["turjaun.xyz"]
}
```

**Error — invalid name (`400`, [v2])**

A `name` that is empty after sanitisation (e.g. `"!!!"`) is rejected in v2:

```json
{ "error": "Invalid name" }
```

**Examples**

```bash
# Random address
curl -s -X POST https://temp-mail.turjaun.workers.dev/api/new_address \
  -H "Content-Type: application/json" \
  -d '{"domain":"turjaun.xyz"}'

# Chosen name
curl -s -X POST https://temp-mail.turjaun.workers.dev/api/new_address \
  -H "Content-Type: application/json" \
  -d '{"name":"signup-test-01","domain":"turjaun.xyz"}'
```

---

### GET /api/mails

Lists mails for **the inbox identified by the bearer token**, newest first.
Results are **summaries** (subject + preview, no full body) — fetch
`GET /api/mail/:id` for a full message.

| Item | Value |
|---|---|
| Method / path | `GET /api/mails` |
| Auth | **Bearer token required** (header preferred, `?token=` accepted) |
| Success status | `200` |
| Cache | ETag supported **[v2]** — see [Caching / ETag](#caching--etag) |

**Query params**

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `limit` | integer | No | `20` | Page size. **Maximum `50`** — larger values are clamped to `50` in v1. |
| `offset` | integer | No | `0` | Offset pagination: rows to skip. See [Pagination](#pagination--offset-vs-cursor) before relying on it for sync. |
| `since_id` | integer | No **[v2]** | — | Cursor: return only mails with `id > since_id`. For incremental sync / "what's new since I last looked". |
| `before_id` | integer | No **[v2]** | — | Cursor: return only mails with `id < before_id`. For paging backwards through history without offset drift. |
| `token` | string | No | — | Fallback auth instead of the `Authorization` header. Avoid in production (see [Authentication](#authentication)). |

Cursor rules **[v2]**:

- `since_id` and `before_id` may be combined (`since_id < id < before_id`).
- Do **not** combine cursor params with `offset`. A request that supplies
  both returns `400` (see errors below) — pick one pagination mode per request.
- Ordering stays `id DESC` (newest first) in cursor mode, exactly as in
  offset mode, so response handling code does not change.
- See [Pagination — offset vs cursor](#pagination--offset-vs-cursor) for the
  full model and worked examples.

**Success response**

```json
{
  "address": "test123@turjaun.xyz",
  "count": 2,
  "results": [
    {
      "id": 42,
      "address": "test123@turjaun.xyz",
      "sender": "no-reply@service.example",
      "subject": "Your verification code is 123456",
      "preview": "Your verification code is 123456. It expires in 10 minutes…",
      "created_at": 1795348800
    },
    {
      "id": 41,
      "address": "test123@turjaun.xyz",
      "sender": "hello@service.example",
      "subject": "Welcome — please confirm your email",
      "preview": "Thanks for signing up. Confirm your address by opening…",
      "created_at": 1795345200
    }
  ],
  "latest_id": 42,
  "next_before_id": 41
}
```

| Field | Type | Notes |
|---|---|---|
| `address` | string | The inbox the token belongs to (resolved server-side from the token — there is no address parameter on this endpoint). |
| `count` | integer | Number of results **in this page**, not the total inbox size. `count == results.length`, always. |
| `results[].id` | integer | Mail ID. Use with `GET /api/mail/:id`, `DELETE /api/mail/:id`, and as a cursor value. |
| `results[].address` | string | Recipient address (same as the top-level `address`). |
| `results[].sender` | string \| null | Sender address as stored from the inbound mail. |
| `results[].subject` | string \| null | Subject; `"(no subject)"` may appear for mail that arrived without one. |
| `results[].preview` | string \| null | First **200 characters** of `text_body` (`substr(text_body,1,200)` in v1). Not word-trimmed; may end mid-word. No `otp` field in this shape — use the inbox-messages endpoint or fetch the single mail for OTP extraction. |
| `results[].created_at` | integer | Unix seconds when the mail was stored. |
| `latest_id` | integer \| null | **[v2]** Largest mail `id` in this page, or `null` when the page is empty. Save it and pass it as `since_id` next time to fetch only newer mail. |
| `next_before_id` | integer \| null | **[v2]** Smallest mail `id` in this page, or `null` when the page is empty. Pass it as `before_id` to fetch the next older page. |

An empty inbox is a success, not an error:

```json
{ "address": "test123@turjaun.xyz", "count": 0, "results": [], "latest_id": null, "next_before_id": null }
```

*(In v1 the same empty response omits `latest_id` / `next_before_id`.)*

**Error — unauthorised (`401`)**

Missing token, or a token that matches no address:

```json
{ "error": "Unauthorized" }
```

**Error — mixed pagination modes (`400`, [v2])**

```json
{ "error": "Cannot combine offset with cursor pagination" }
```

**Examples**

```bash
# First page (v1-compatible)
curl -s "https://temp-mail.turjaun.workers.dev/api/mails?limit=20&offset=0" \
  -H "Authorization: Bearer $TOKEN"

# Only mail newer than id 42 [v2]
curl -s "https://temp-mail.turjaun.workers.dev/api/mails?since_id=42" \
  -H "Authorization: Bearer $TOKEN"

# Next older page before id 41 [v2]
curl -s "https://temp-mail.turjaun.workers.dev/api/mails?before_id=41&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

---

### GET /api/inboxes/:address/messages

Lists **full** mails (complete bodies, plus `otp`) for an explicit address,
newest first. This is the endpoint to use after `GET /api/wait` tells you
mail has arrived, or in the web UI where the address is already known.

| Item | Value |
|---|---|
| Method / path | `GET /api/inboxes/:address/messages` |
| Auth | None in v1 (address is the capability). **Send the Bearer header anyway** — v2 deployments following `AGENTS.md` expect it on inbox/message calls and may enforce it. |
| Success status | `200` — including for an address with no mail, and for an address that has never existed |
| Cache | ETag supported **[v2]** |

**Path params**

| Param | Type | Required | Notes |
|---|---|---|---|
| `address` | string | Yes | Full address, URL-encoded if it contains reserved characters (`test123%40turjaun.xyz` also works; a literal `@` in the path is accepted by v1). Decoded and lower-cased server-side. |

**Query params**

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `limit` | integer | No | `20` | Maximum `50` (clamped in v1). No `offset` parameter on this endpoint in v1 — use `GET /api/mails` for paging, or `limit` only. |

**Success response**

```json
{
  "address": "test123@turjaun.xyz",
  "count": 1,
  "results": [
    {
      "id": 42,
      "address": "test123@turjaun.xyz",
      "sender": "no-reply@service.example",
      "subject": "Your verification code is 123456",
      "text_body": "Your verification code is 123456. It expires in 10 minutes.",
      "html_body": "<p>Your verification code is <b>123456</b>. It expires in 10 minutes.</p>",
      "created_at": 1795348800,
      "otp": "123456"
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `address` | string | The address as decoded/lower-cased by the server. |
| `count` | integer | Results in this response (`== results.length`). |
| `results[].text_body` | string \| null | Plain-text body, up to 50,000 chars as stored by the inbound parser. May be `""` for HTML-only mail. |
| `results[].html_body` | string \| null | HTML body as stored, or `""` if the mail had no HTML part. **Treat as untrusted content** — never inject it into a page without sanitisation. |
| `results[].otp` | string \| null | First 4–8 digit sequence in `text_body` + `subject`, or `null`. |
| _(other fields)_ | | `id`, `sender`, `subject`, `created_at` — as defined under `GET /api/mails`. Note: no `preview` and no `raw_size` in this shape. |

Empty inbox:

```json
{ "address": "test123@turjaun.xyz", "count": 0, "results": [] }
```

**Error example**

This endpoint has no endpoint-specific error in v1 — an unknown address is
the empty result above, not a `404`. The generic errors still apply:

```http
HTTP/1.1 404 Not Found
```

```json
{ "error": "Not found", "path": "/api/inboxes/test123@turjaun.xyz" }
```

*(Missing the trailing `/messages` segment, so the route does not match.)*

**Example**

```bash
curl -s "https://temp-mail.turjaun.workers.dev/api/inboxes/test123@turjaun.xyz/messages?limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

---

### GET /api/mail/:id

Fetches one mail in full — every stored column, plus the extracted `otp`.
Use it for verification links (scan `text_body` first, then `html_body`)
and whenever a list preview is not enough.

| Item | Value |
|---|---|
| Method / path | `GET /api/mail/:id` |
| Auth | None in v1. **Send the Bearer header anyway** (see the note under `/api/inboxes/:address/messages`). |
| Success status | `200` |
| Cache | ETag supported **[v2]** |

**Path params**

| Param | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | Yes | Mail ID from a list response. The route only matches **numeric** IDs — `/api/mail/abc` falls through to the generic `404` with a `path` field (see below). |

**Success response**

```json
{
  "id": 42,
  "address": "test123@turjaun.xyz",
  "sender": "no-reply@service.example",
  "subject": "Your verification code is 123456",
  "text_body": "Your verification code is 123456. It expires in 10 minutes.",
  "html_body": "<p>Your verification code is <b>123456</b>. It expires in 10 minutes.</p>",
  "raw_size": 812,
  "created_at": 1795348800,
  "otp": "123456"
}
```

| Field | Type | Notes |
|---|---|---|
| _(all `mails` columns)_ | | This is a `SELECT *` shape in v1: `id`, `address`, `sender`, `subject`, `text_body`, `html_body`, `raw_size`, `created_at`. |
| `raw_size` | integer | Size in bytes of the raw inbound message as received. `0` may appear for fallback/parse-failed rows. |
| `otp` | string \| null | Added by the handler — not a stored column. First 4–8 digit sequence in `text_body` + `subject`, or `null`. |

**Error — mail not found (`404`)**

```json
{ "error": "Not found" }
```

Note: this endpoint-specific `404` has **no** `path` field.

**Error — non-numeric ID (`404`, generic)**

```json
{ "error": "Not found", "path": "/api/mail/abc" }
```

**Example**

```bash
curl -s "https://temp-mail.turjaun.workers.dev/api/mail/42" \
  -H "Authorization: Bearer $TOKEN"
```

---

### DELETE /api/mail/:id

Permanently deletes one mail. There is no undo and no trash.

| Item | Value |
|---|---|
| Method / path | `DELETE /api/mail/:id` |
| Auth | None in the v1 baseline code. **[v2]** Bearer token **required** per `AGENTS.md` §3 — always send it; v2 returns `401` without a valid token for the owning inbox. |
| Success status | `200` |

**Path params**

| Param | Type | Required | Notes |
|---|---|---|---|
| `id` | integer | Yes | Numeric mail ID, as for `GET /api/mail/:id`. |

**Success response**

```json
{ "ok": true }
```

v1 returns this unconditionally once the route matches — including when the
ID had already been deleted (the underlying `DELETE` simply affects zero
rows). Do not use the response to confirm the mail existed; re-list if you
need certainty. Delete only IDs that belong to your inbox and that you have
already consumed.

**Error — unauthorised (`401`, [v2])**

```json
{ "error": "Unauthorized" }
```

**Error — non-numeric ID (`404`, generic)**

```json
{ "error": "Not found", "path": "/api/mail/abc" }
```

**Example**

```bash
curl -s -X DELETE "https://temp-mail.turjaun.workers.dev/api/mail/42" \
  -H "Authorization: Bearer $TOKEN"
```

---

### GET /api/wait — [v2]

**Long-poll.** Holds the request open until a new mail arrives for the
inbox, then returns immediately — or returns an empty timeout result when
the wait expires. One `/api/wait` call replaces dozens of polling requests
and is the **only** supported way to wait for mail. It is new in v2; it does
not exist in the v1 baseline.

| Item | Value |
|---|---|
| Method / path | `GET /api/wait` |
| Auth | **Bearer token** (header or `?token=`), **or** an `address` parameter (address-as-capability, consistent with `/api/inboxes/:address/messages`) |
| Success status | `200` for both the "mail arrived" and the "timed out" outcomes — timeout is **not** an HTTP error |
| Cache | `Cache-Control: no-store` — a wait result must never be cached or replayed |

**Query params**

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `since_id` | integer ≥ 0 | No | Latest mail ID for the inbox at the moment the request starts | Only mails with `id > since_id` count as "new". Pass the largest ID you have already seen (typically `latest_id` from your last list/wait response). `0` means "any mail already in the inbox counts" — the call returns immediately if the inbox is non-empty. |
| `address` | string | No* | Derived from the token | The inbox to wait on. Required if no token is supplied. If both are supplied, they must refer to the same inbox, otherwise `401`. Lower-cased server-side. |
| `token` | string | No* | — | Fallback auth instead of the `Authorization` header. *Either a valid token or an `address` must be present — see errors. |
| `timeout` | integer (seconds) | No | `25` | How long the server holds the request. Minimum `1`, **maximum `30`** — larger values are clamped to `30`. The cap keeps the request inside platform (Cloudflare Workers) request-duration limits. |
| `limit` | integer | No | `20` | Maximum number of new mails to include if several arrive together. Maximum `50` (clamped). |

**Timeout behaviour — read this before implementing a client**

1. On arrival, the server checks once, immediately. If any mail with
   `id > since_id` already exists, it returns at once — a wait call on a
   non-empty delta never blocks.
2. Otherwise the server keeps the request open, re-checking the inbox
   periodically (implementation detail: roughly every 2 s), and returns
   **as soon as at least one** new mail exists — it does not wait for the
   full timeout to "collect" mail.
3. If no new mail exists when `timeout` seconds have elapsed, the server
   returns HTTP `200` with `"timeout": true` and an empty `results` array.
4. One call = **one wait cycle**. To keep waiting after a timeout, the
   client starts a new cycle with the same (or an updated) `since_id`.
   Never run two wait calls for the same inbox in parallel, and never
   fall back to rapid `GET /api/mails` polling between cycles — see
   [Rate limits & polling etiquette](#rate-limits--polling-etiquette).
5. Set your HTTP client's own timeout to at least `timeout + 5` seconds,
   or the client will abort a healthy long-poll just before it answers.
6. For a normal sign-up OTP flow, give up after 3–5 consecutive timeout
   cycles and report that no mail arrived.

**Success response — new mail arrived**

Results use the **full-message shape** (same fields as
`GET /api/inboxes/:address/messages`, including `otp`), because the caller
is almost always waiting for a code or a link and should not need a second
request to read it.

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "address": "test123@turjaun.xyz",
  "since_id": 41,
  "latest_id": 42,
  "timeout": false,
  "waited_ms": 6310,
  "count": 1,
  "results": [
    {
      "id": 42,
      "address": "test123@turjaun.xyz",
      "sender": "no-reply@service.example",
      "subject": "Your verification code is 123456",
      "text_body": "Your verification code is 123456. It expires in 10 minutes.",
      "html_body": "<p>Your verification code is <b>123456</b>. It expires in 10 minutes.</p>",
      "created_at": 1795348806,
      "otp": "123456"
    }
  ]
}
```

**Success response — timeout, no new mail**

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "address": "test123@turjaun.xyz",
  "since_id": 41,
  "latest_id": 41,
  "timeout": true,
  "waited_ms": 25004,
  "count": 0,
  "results": []
}
```

| Field | Type | Notes |
|---|---|---|
| `address` | string | The inbox that was waited on. |
| `since_id` | integer | Echo of the effective cursor the server used (the supplied value, or the at-start latest ID if omitted). |
| `latest_id` | integer | Largest mail ID now known for the inbox. On success this is the newest returned mail's ID; on timeout it equals `since_id`. **Feed this back as the next call's `since_id`.** |
| `timeout` | boolean | `true` = the wait expired with no new mail. `false` = `results` contains new mail. Branch on this field, not on `count` alone. |
| `waited_ms` | integer | Milliseconds the server actually held the request. Small (single/double digits) for an immediate return, ≈ `timeout * 1000` on timeout. |
| `count` | integer | `== results.length`. |
| `results` | object[] | Full messages, newest first, IDs all `> since_id`. Empty on timeout. |

**Error — nothing to wait on (`400`)**

Neither a token nor an `address` was supplied:

```json
{ "error": "Missing address or token" }
```

**Error — invalid parameter (`400`)**

Non-integer or negative `since_id`, or a non-numeric `timeout`:

```json
{ "error": "Invalid since_id" }
```

```json
{ "error": "Invalid timeout" }
```

**Error — unauthorised (`401`)**

Token does not match any address, or the supplied `address` does not belong
to the supplied token:

```json
{ "error": "Unauthorized" }
```

**Examples**

```bash
# Wait with a token (address derived from the token) — the normal agent flow
curl -s "https://temp-mail.turjaun.workers.dev/api/wait" \
  -H "Authorization: Bearer $TOKEN"

# Wait for mail newer than id 41, up to 30 s
curl -s "https://temp-mail.turjaun.workers.dev/api/wait?since_id=41&timeout=30" \
  -H "Authorization: Bearer $TOKEN"

# Wait by address, no token (address-as-capability mode)
curl -s "https://temp-mail.turjaun.workers.dev/api/wait?address=test123@turjaun.xyz&since_id=41"
```

**Client loop (JavaScript)**

```js
let sinceId = 41; // largest mail ID already seen, 0 if none
for (let cycle = 0; cycle < 5; cycle++) {
  const res = await fetch(
    `${BASE}/api/wait?since_id=${sinceId}&timeout=25`,
    { headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(35_000) } // client timeout > server timeout
  );
  if (!res.ok) throw new Error(`wait failed: ${res.status}`);
  const data = await res.json();
  sinceId = data.latest_id;               // always advance the cursor
  if (!data.timeout && data.count > 0) {
    const otp = data.results[0].otp;       // newest mail, OTP pre-extracted
    // …use the code / link, then stop waiting…
    break;
  }
  // timeout with no mail: loop starts the next wait cycle — nothing else to do
}
```

---

## Pagination — offset vs cursor

Two paging models exist. They serve different jobs; do not mix them in one
request (v2 rejects `offset` combined with a cursor parameter with `400`).

### Offset pagination (v1)

Available on `GET /api/mails` via `limit` + `offset`. Results are ordered
`id DESC`.

```text
Page 1:  GET /api/mails?limit=20&offset=0
Page 2:  GET /api/mails?limit=20&offset=20
Page 3:  GET /api/mails?limit=20&offset=40
```

**Strengths:** simple, can jump to any page, fine for a human browsing a
mailbox in the UI.

**Weakness — drift:** offset counts from the *current* head of the list.
If a new mail arrives between fetching page 1 and page 2, every row shifts
down one: the last mail of page 1 reappears as the first mail of page 2,
and with deletions a mail can be skipped entirely. For a mailbox that is
receiving mail while you read it — the normal temp-mail case — offset
pages are not a stable snapshot.

### Cursor pagination [v2]

Available on `GET /api/mails` via the mail ID itself as the cursor. IDs are
monotonic, so a cursor pins an exact position that new arrivals cannot move.

| Cursor | Meaning | Typical use |
|---|---|---|
| `since_id=N` | Only mails with `id > N` | Incremental sync: "everything since I last looked" |
| `before_id=N` | Only mails with `id < N` | Stable history paging: "the page older than this" |

**Stable history paging with `before_id`:**

```text
Page 1:  GET /api/mails?limit=20
         -> results ids 60..41, latest_id=60, next_before_id=41
Page 2:  GET /api/mails?limit=20&before_id=41
         -> results ids 40..21, next_before_id=21
Page 3:  GET /api/mails?limit=20&before_id=21
         -> results ids 20..3,  next_before_id=3
Next:    GET /api/mails?limit=20&before_id=3
         -> results ids 2..1, then a request with before_id=1 returns count:0 (end)
```

New mail arriving mid-walk gets an ID above 60 and can never enter, shift,
or duplicate these pages.

**Incremental sync with `since_id`:**

```text
First:   GET /api/mails?limit=50
         -> save latest_id (e.g. 60)
Later:   GET /api/mails?since_id=60
         -> only mail that arrived after the first fetch (ids 61, 62, …)
         -> save the new latest_id from the response
```

If you only ever need "what's new", prefer `GET /api/wait` over repeated
`since_id` fetches — the wait endpoint *is* a `since_id` fetch that blocks
server-side instead of making the client poll.

### Which should I use?

| Situation | Use |
|---|---|
| Waiting for a specific mail / OTP | `GET /api/wait` **[v2]** |
| Syncing new mail into a client | `GET /api/mails?since_id=…` **[v2]** |
| Walking the whole history of an inbox | `GET /api/mails?before_id=…` **[v2]** |
| Simple UI page numbers, mail arriving is unlikely mid-browse | `GET /api/mails?limit=&offset=` (v1) |
| One quick look at the newest mail | `GET /api/mails?limit=20` (v1) |

Rules that apply to both models: `limit` defaults to `20` and is clamped
to a maximum of `50`; ordering is always `id DESC`; `count` is the page
size actually returned, never a total.

---

## Caching / ETag

> **v1 status:** the baseline sends **no** `ETag` and **no** `Cache-Control`
> on API responses — only `Content-Type` and CORS headers. Everything in
> this section is the **[v2]** contract. Clients written against it degrade
> gracefully on a v1 server: no `ETag` header simply means "always fetch".

### Which responses carry an ETag [v2]

| Endpoint | ETag basis | Cache-Control |
|---|---|---|
| `GET /api/mails` | Hash of address + `latest_id` + `count` for the requested page | `private, no-cache` (revalidate every time) |
| `GET /api/inboxes/:address/messages` | Hash of address + newest mail `id` + `count` | `private, no-cache` |
| `GET /api/mail/:id` | Hash of mail `id` + `created_at` (a stored mail never changes) | `private, max-age=300` |
| `GET /api/config`, `GET /api/domains` | Hash of `domains` + `ttl_hours` | `public, max-age=60` |
| `GET /api/health` | — (no ETag) | `no-store` |
| `GET /api/wait`, `POST /api/new_address`, `DELETE /api/mail/:id` | — (no ETag) | `no-store` |

Example ETag format (weak validator, exact string is opaque to clients —
never parse or construct one yourself):

```http
ETag: W/"mails-test123@turjaun.xyz-42-2"
```

### Conditional requests [v2]

Send the stored ETag back as `If-None-Match`. If nothing has changed, the
server answers `304` with an empty body instead of re-sending the list:

```http
GET /api/mails?limit=20 HTTP/1.1
Host: temp-mail.turjaun.workers.dev
Authorization: Bearer <token>
If-None-Match: W/"mails-test123@turjaun.xyz-42-2"
```

```http
HTTP/1.1 304 Not Modified
ETag: W/"mails-test123@turjaun.xyz-42-2"
Cache-Control: private, no-cache
```

Client rules:

- Treat `304` as "your cached copy is current" — it is a success, not an error.
- Store the ETag **per exact URL + token**; a different `limit`, cursor, or
  inbox is a different resource.
- Any new mail changes `latest_id`, so a list ETag invalidates on the next
  arrival — which is exactly the change a polling client is looking for.
- Never send `If-None-Match` to `/api/wait`: the wait must always execute.

### Why bother if `/api/wait` exists?

ETag revalidation makes an occasional manual refresh or a UI re-open cheap
(one tiny `304` instead of a full list body). It is **not** a polling
strategy: a client that revalidates every 2 seconds is still polling every
2 seconds. Use `/api/wait` to wait; use ETags to refresh cheaply.

---

## Rate limits & polling etiquette

### What is enforced

- **v1 enforces no application-level rate limit** in the Worker code — there
  is no counter, quota, or `429` branch in the baseline.
- The service still runs on Cloudflare Workers, so **platform limits apply**
  (per-plan request quotas, abuse protections). If the platform throttles a
  request, the client sees an HTTP `429` (or a platform error page) that did
  not come from the Worker. Treat any `429` as authoritative back-off signal.
- **[v2]** A `429` from this API, when JSON, uses the standard error shape
  and may carry a `Retry-After` header (seconds). Clients **must** honour it:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
Content-Type: application/json
```

```json
{ "error": "Rate limited" }
```

### Polling etiquette — mandatory for all clients

These rules come from `AGENTS.md` §6 and apply to humans' scripts and AI
agents alike:

1. **Use `/api/wait` to wait. Never poll on a timer as a substitute.**
   No fixed-interval looping on `GET /api/mails` — not every 10 s (the v1
   web UI's refresh interval is a UI convenience, not an API pattern to
   copy), and certainly not every 1–2 s.
2. **One outstanding wait per inbox.** Never run two `/api/wait` calls for
   the same inbox in parallel; one call = one wait cycle.
3. **Back off on failure.** On `429`, network errors, or `5xx`: wait at
   least `Retry-After` if given, otherwise exponential back-off starting at
   5 s (5 s, 10 s, 20 s, 40 s, capped at 60 s), with jitter. Never retry in
   a tight loop. For `400`, one corrected retry is allowed; for `401`/`404`,
   fix the cause before any retry (see [Errors](#errors)).
4. **Reuse, don't churn.** One inbox per sign-up/task. Don't pre-create
   pools of addresses, don't create a new inbox because a code is slow —
   use the service's "resend" with the same inbox.
5. **Keep requests small.** Default `limit` (20) unless you truly need
   more; fetch full bodies one message at a time (`/api/mail/:id`), not
   list-wide.
6. **Use cursors, not re-downloads.** Sync with `since_id`; revalidate
   lists with `If-None-Match`. A refresh should normally move a few hundred
   bytes, not the whole inbox.
7. **Stop when you're done.** Cancel any pending wait when the task ends
   or is abandoned, stop refreshing hidden UI tabs, and let the inbox
   expire on its 24 h TTL instead of keeping it alive.
8. **Health-check at most once** at the start of a run. Never loop on
   `/api/health`.

### Cost intuition

| Strategy to notice one OTP that arrives after ~30 s | Requests |
|---|---|
| Poll `/api/mails` every 2 s | ~15 |
| Poll `/api/mails` every 10 s | ~3–4, and up to 10 s late |
| One `GET /api/wait?timeout=30` | **1**, returns the moment the mail lands |

---

## Errors

All errors are JSON with a single `error` string (plus, for two cases, an
extra field as noted). There is no error code enum in v1 or v2 — branch on
the HTTP status, use `error` for humans and logs.

| Status | Body | Where | Meaning / client action |
|---|---|---|---|
| `400` | `{"error":"Invalid domain","allowed":["turjaun.xyz"]}` | `POST /api/new_address` | Domain not configured. Use one of `allowed`, or omit `domain`. One corrected retry. |
| `400` | `{"error":"Invalid name"}` | `POST /api/new_address` **[v2]** | Name empty after sanitisation. Use letters/digits/`.`/`_`/`-`, or omit `name`. |
| `400` | `{"error":"Cannot combine offset with cursor pagination"}` | `GET /api/mails` **[v2]** | `offset` sent together with `since_id`/`before_id`. Resend with one mode only. |
| `400` | `{"error":"Missing address or token"}` | `GET /api/wait` **[v2]** | Neither credential supplied. Add the Bearer header or `address`. |
| `400` | `{"error":"Invalid since_id"}` / `{"error":"Invalid timeout"}` | `GET /api/wait` **[v2]** (and `since_id` on `GET /api/mails`) | Non-integer/negative cursor, or non-numeric timeout. Fix and retry once. |
| `401` | `{"error":"Unauthorized"}` | `GET /api/mails`, `GET /api/wait`, `DELETE /api/mail/:id` **[v2]** | Missing/invalid token, token/address mismatch, or expired inbox. **Stop** — verify the token and its inbox; do not try other tokens. If expired (24 h TTL), create a new inbox and restart the flow. |
| `404` | `{"error":"Not found"}` | `GET /api/mail/:id` | No mail with that (numeric) ID. Do not retry the same ID; re-list and pick a current one. |
| `404` | `{"error":"Not found","path":"<path>"}` | Any unmatched route, incl. non-numeric mail IDs | Typo'd or unknown path. Check the path against the endpoint index. |
| `429` | `{"error":"Rate limited"}` (+ `Retry-After`) | Any endpoint, platform or **[v2]** | Back off per [Rate limits](#rate-limits--polling-etiquette). |
| `200` | `{"count":0,"results":[], …}` | List / wait endpoints | **Not an error.** The inbox is empty, or the wait timed out (`"timeout":true` on `/api/wait`). Start another wait cycle if appropriate. |

Generic catch-all example:

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{ "error": "Not found", "path": "/api/unknown" }
```

---

## OpenAPI-style spec

OpenAPI 3.0.3 description of the same contract. The prose above wins where
the two disagree on a v1 quirk (e.g. the reused-address response shape);
**[v2]** items are marked with `x-version: v2` / description notes.

```yaml
openapi: 3.0.3
info:
  title: Temp Mail API
  description: >
    Disposable email for turjaun.xyz. v1 endpoints are live at the base URL;
    items whose description starts with [v2] are v2 additions (cursor
    pagination on /api/mails, /api/wait, ETag support, DELETE auth).
  version: 2.0.0
servers:
  - url: https://temp-mail.turjaun.workers.dev
    description: Live service
security:
  - {}            # most endpoints are public; per-endpoint security overrides below
paths:
  /api/health:
    get:
      summary: Liveness check
      security: []
      responses:
        '200':
          description: Service is up
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Health' }
              example:
                ok: true
                service: temp-mail
                domain: [turjaun.xyz]
                time: '2026-11-21T12:29:13.646Z'
  /api/config:
    get:
      summary: Public configuration (domains + retention)
      security: []
      responses:
        '200':
          description: Configuration
          headers:
            ETag: { $ref: '#/components/headers/ETag' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Config' }
              example: { domains: [turjaun.xyz], ttl_hours: 24 }
        '304': { $ref: '#/components/responses/NotModified' }
  /api/domains:
    get:
      summary: Alias of GET /api/config (identical body in v1)
      security: []
      responses:
        '200':
          description: Configuration
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Config' }
  /api/new_address:
    post:
      summary: Create (or re-claim) a disposable inbox
      security: []
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: '#/components/schemas/NewAddressRequest' }
            examples:
              random: { value: { domain: turjaun.xyz } }
              named:  { value: { name: test123, domain: turjaun.xyz } }
      responses:
        '200':
          description: Inbox created, or existing inbox returned (see `reused`)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/NewAddressResponse' }
              examples:
                created:
                  value:
                    address: test123@turjaun.xyz
                    token: 113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62
                    jwt: 113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62
                    expires_at: 1795350561
                reused:
                  value:
                    address: test123@turjaun.xyz
                    token: 113f4f4ca0e917d9ecc662129d6f9b4f002da2e6aef18dc863c45bc8bcf25f62
                    reused: true
        '400':
          description: Invalid domain (or, [v2], invalid name)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
              example: { error: Invalid domain, allowed: [turjaun.xyz] }
  /api/mails:
    get:
      summary: List mails for the token's inbox (preview shape, newest first)
      security:
        - bearerToken: []
      parameters:
        - { name: limit,     in: query, schema: { type: integer, default: 20, maximum: 50 } }
        - { name: offset,    in: query, schema: { type: integer, default: 0 },
            description: Offset pagination (v1). Must not be combined with a cursor parameter. }
        - { name: since_id,  in: query, schema: { type: integer, minimum: 0 },
            description: '[v2] Cursor — only mails with id > since_id.' }
        - { name: before_id, in: query, schema: { type: integer, minimum: 1 },
            description: '[v2] Cursor — only mails with id < before_id.' }
        - { name: token,     in: query, schema: { type: string },
            description: Fallback auth instead of the Authorization header (discouraged). }
        - { name: If-None-Match, in: header, schema: { type: string },
            description: '[v2] Conditional request — see Caching / ETag.' }
      responses:
        '200':
          description: One page of mail summaries
          headers:
            ETag: { $ref: '#/components/headers/ETag' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/MailPreviewList' }
        '304': { $ref: '#/components/responses/NotModified' }
        '400':
          description: Offset combined with a cursor parameter [v2]
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
              example: { error: Cannot combine offset with cursor pagination }
        '401':
          description: Missing or invalid token
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
              example: { error: Unauthorized }
  /api/inboxes/{address}/messages:
    get:
      summary: List full mails for an explicit address
      security: []   # v1: address is the capability; send Bearer anyway (see prose)
      parameters:
        - name: address
          in: path
          required: true
          schema: { type: string }
          example: test123@turjaun.xyz
        - { name: limit, in: query, schema: { type: integer, default: 20, maximum: 50 } }
        - { name: If-None-Match, in: header, schema: { type: string },
            description: '[v2] Conditional request.' }
      responses:
        '200':
          description: Full messages, newest first (empty list for unknown addresses)
          headers:
            ETag: { $ref: '#/components/headers/ETag' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/MailFullList' }
        '304': { $ref: '#/components/responses/NotModified' }
  /api/mail/{id}:
    get:
      summary: Fetch one mail in full, with otp
      security: []   # v1: no auth; send Bearer anyway (see prose)
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: integer }
      responses:
        '200':
          description: The mail
          headers:
            ETag: { $ref: '#/components/headers/ETag' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/MailFull' }
        '304': { $ref: '#/components/responses/NotModified' }
        '404':
          description: No mail with that ID
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
              example: { error: Not found }
    delete:
      summary: Delete one mail permanently
      security:
        - bearerToken: []   # [v2] required; v1 baseline required no auth
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: integer }
      responses:
        '200':
          description: Deleted (v1 also returns this if the ID was already gone)
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, example: true }
        '401':
          description: '[v2] Missing or invalid token'
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
              example: { error: Unauthorized }
  /api/wait:
    get:
      summary: '[v2] Long-poll — block until new mail arrives or the timeout elapses'
      description: >
        [v2] Returns immediately if mail with id > since_id already exists,
        otherwise holds the request (server default timeout 25 s, max 30 s)
        and returns as soon as the first new mail lands. A timeout is HTTP
        200 with timeout:true and empty results, not an error. One call is
        one wait cycle; never run parallel waits for one inbox.
      security:
        - bearerToken: []
        - {}            # or address-as-capability via the address parameter
      parameters:
        - { name: since_id, in: query, schema: { type: integer, minimum: 0 },
            description: Only mail with id > since_id counts as new. Default — latest ID at request start. }
        - { name: address,  in: query, schema: { type: string },
            description: Inbox to wait on. Required without a token; must match the token's inbox if both are given. }
        - { name: token,    in: query, schema: { type: string },
            description: Fallback auth instead of the Authorization header (discouraged). }
        - { name: timeout,  in: query, schema: { type: integer, default: 25, minimum: 1, maximum: 30 },
            description: Seconds the server holds the request; larger values are clamped to 30. }
        - { name: limit,    in: query, schema: { type: integer, default: 20, maximum: 50 } }
      responses:
        '200':
          description: New mail arrived (timeout:false) or wait expired (timeout:true)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/WaitResponse' }
              examples:
                arrived:
                  value:
                    address: test123@turjaun.xyz
                    since_id: 41
                    latest_id: 42
                    timeout: false
                    waited_ms: 6310
                    count: 1
                    results:
                      - id: 42
                        address: test123@turjaun.xyz
                        sender: no-reply@service.example
                        subject: Your verification code is 123456
                        text_body: Your verification code is 123456. It expires in 10 minutes.
                        html_body: <p>Your verification code is <b>123456</b>.</p>
                        created_at: 1795348806
                        otp: '123456'
                timedOut:
                  value:
                    address: test123@turjaun.xyz
                    since_id: 41
                    latest_id: 41
                    timeout: true
                    waited_ms: 25004
                    count: 0
                    results: []
        '400':
          description: Neither address nor token, or an invalid parameter
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
              examples:
                missing: { value: { error: Missing address or token } }
                invalid: { value: { error: Invalid since_id } }
        '401':
          description: Invalid token, or address/token mismatch
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
              example: { error: Unauthorized }
components:
  securitySchemes:
    bearerToken:
      type: http
      scheme: bearer
      description: >
        Per-inbox token returned by POST /api/new_address (64-char hex).
        The same value is also returned in the `jwt` field on creation.
  headers:
    ETag:
      description: '[v2] Weak validator for conditional requests (If-None-Match).'
      schema: { type: string, example: 'W/"mails-test123@turjaun.xyz-42-2"' }
  responses:
    NotModified:
      description: '[v2] If-None-Match matched — the client copy is current; body is empty.'
  schemas:
    Error:
      type: object
      properties:
        error:   { type: string }
        allowed: { type: array, items: { type: string },
                   description: Present only on the Invalid domain error. }
        path:    { type: string,
                   description: Present only on the generic catch-all 404. }
      required: [error]
    Health:
      type: object
      properties:
        ok:      { type: boolean, example: true }
        service: { type: string, example: temp-mail }
        domain:  { type: array, items: { type: string }, example: [turjaun.xyz] }
        time:    { type: string, format: date-time }
      required: [ok, service, domain, time]
    Config:
      type: object
      properties:
        domains:   { type: array, items: { type: string }, example: [turjaun.xyz] }
        ttl_hours: { type: integer, example: 24 }
      required: [domains, ttl_hours]
    NewAddressRequest:
      type: object
      properties:
        name:   { type: string,
                  description: 'Desired local part; sanitised to a–z 0–9 . _ - and lower-cased. Random if omitted.' }
        domain: { type: string, example: turjaun.xyz,
                  description: Must be a configured domain; defaults to the first configured domain. }
    NewAddressResponse:
      type: object
      properties:
        address:    { type: string, example: test123@turjaun.xyz }
        token:      { type: string, description: 64-char hex per-inbox bearer token. }
        jwt:        { type: string, description: 'Legacy alias of token. Absent on a reused response.' }
        expires_at: { type: integer, description: 'Unix seconds. Absent on a reused response.' }
        reused:     { type: boolean, description: 'Present and true when an existing inbox was returned.' }
      required: [address, token]
    MailPreview:
      type: object
      properties:
        id:         { type: integer, example: 42 }
        address:    { type: string, example: test123@turjaun.xyz }
        sender:     { type: string, nullable: true }
        subject:    { type: string, nullable: true }
        preview:    { type: string, nullable: true,
                      description: First 200 characters of text_body. }
        created_at: { type: integer, description: Unix seconds. }
      required: [id, address, created_at]
    MailFull:
      type: object
      properties:
        id:         { type: integer, example: 42 }
        address:    { type: string, example: test123@turjaun.xyz }
        sender:     { type: string, nullable: true }
        subject:    { type: string, nullable: true }
        text_body:  { type: string, nullable: true }
        html_body:  { type: string, nullable: true,
                      description: Untrusted content — sanitise before rendering. }
        raw_size:   { type: integer,
                      description: 'Bytes of the raw inbound message. Present on GET /api/mail/:id; absent from list shapes.' }
        created_at: { type: integer, description: Unix seconds. }
        otp:        { type: string, nullable: true,
                      description: First 4–8 digit sequence in text_body + subject, or null. }
      required: [id, address, created_at, otp]
    MailPreviewList:
      type: object
      properties:
        address:        { type: string }
        count:          { type: integer, description: '== results.length (page size, not a total).' }
        results:        { type: array, items: { $ref: '#/components/schemas/MailPreview' } }
        latest_id:      { type: integer, nullable: true,
                          description: '[v2] Largest ID in the page; null when empty.' }
        next_before_id: { type: integer, nullable: true,
                          description: '[v2] Smallest ID in the page; pass as before_id for the next older page.' }
      required: [address, count, results]
    MailFullList:
      type: object
      properties:
        address: { type: string }
        count:   { type: integer }
        results: { type: array, items: { $ref: '#/components/schemas/MailFull' } }
      required: [address, count, results]
    WaitResponse:
      type: object
      properties:
        address:   { type: string }
        since_id:  { type: integer, description: Effective cursor used by the server. }
        latest_id: { type: integer, description: Feed back as the next since_id. }
        timeout:   { type: boolean, description: 'true = wait expired with no new mail (still HTTP 200).' }
        waited_ms: { type: integer }
        count:     { type: integer }
        results:   { type: array, items: { $ref: '#/components/schemas/MailFull' } }
      required: [address, since_id, latest_id, timeout, waited_ms, count, results]
```

---

## Changelog v1 → v2

### Added

- **`GET /api/wait` — long-poll endpoint.** Blocks server-side until mail
  with `id > since_id` arrives or `timeout` (default 25 s, max 30 s)
  elapses. Timeout is `200` with `"timeout": true`, not an error. Returns
  full messages including `otp`, plus `latest_id` / `waited_ms` bookkeeping
  fields. This replaces timer polling as the supported wait pattern
  (`AGENTS.md` §2 Step 4, §6 rule 1).
- **Cursor pagination on `GET /api/mails`** — `since_id` (newer-than, for
  incremental sync) and `before_id` (older-than, for drift-free history
  paging). Response gains `latest_id` and `next_before_id`. Offset
  pagination is unchanged for existing clients; combining `offset` with a
  cursor in one request is a `400`.
- **ETag / conditional requests** on `GET /api/mails`,
  `GET /api/inboxes/:address/messages`, `GET /api/mail/:id`, and
  `GET /api/config` / `/api/domains`, with `Cache-Control` guidance per
  endpoint and `304 Not Modified` for unchanged resources. v1 sent no
  caching headers at all.
- **New error cases** (all in the existing `{"error": …}` shape):
  `Missing address or token` and `Invalid since_id` / `Invalid timeout`
  (`400`, `/api/wait`), `Cannot combine offset with cursor pagination`
  (`400`, `/api/mails`), and a documented JSON `429 Rate limited` with
  `Retry-After`.

### Changed / hardened

- **`DELETE /api/mail/:id` now requires the Bearer token** for the owning
  inbox (`401` without one), per `AGENTS.md` §3. The v1 baseline performed
  the delete with no auth check. Clients that already send the header —
  as `AGENTS.md` has always instructed — see no change.
- **`POST /api/new_address` rejects a name that sanitises to empty** with
  `400 {"error":"Invalid name"}` (`AGENTS.md` §5). v1 silently produced a
  degenerate address.
- **Auth expectations on read-by-address / read-by-id endpoints made
  explicit:** `GET /api/inboxes/:address/messages` and `GET /api/mail/:id`
  keep their v1 no-auth, address/ID-as-capability behaviour, but clients
  must send the Bearer header on these calls too, and v2 deployments may
  enforce it. No response shape changes.

### Unchanged (explicitly)

- Base URL, domain (`turjaun.xyz`), 24-hour TTL, and the hourly cleanup.
- All v1 response shapes, field names, and quirks: `domain` (singular) on
  `/api/health` vs `domains` on `/api/config`; `token` + identical `jwt`
  alias on inbox creation; the `reused` create shape without
  `jwt`/`expires_at`; `count` meaning "items in this page"; `preview`
  truncated to 200 chars on `/api/mails` with no `otp` in that shape;
  `200` (not `201`) on address creation; endpoint-specific `404`
  (`{"error":"Not found"}`) vs catch-all `404` (with `path`).
- Ordering (`id DESC`) and `limit` semantics (default `20`, max `50`) on
  every list endpoint.
- No accounts, no passwords, no API keys beyond the per-inbox token, and
  no sending-mail endpoints — Temp Mail remains receive-only.

---

*Document: `docs/API.md` · Service: `https://temp-mail.turjaun.workers.dev` ·
Companion file for agents: `AGENTS.md` (repo root) — the mandatory workflow
and etiquette rules for automated consumers of this API.*
