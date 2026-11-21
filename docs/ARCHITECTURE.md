# Temp Mail v2 — Architecture

Domain: `turjaun.xyz` · Live service: `https://temp-mail.turjaun.workers.dev`
Stack (unchanged in kind): Cloudflare Email Routing → Cloudflare Worker → D1 (SQLite)
Stack (changed in degree): + Rust→WASM MIME parser, + long-poll sync, + incremental UI

This document is the design contract for v2. Endpoint shapes, index definitions,
header names, and budgets stated here are normative for the other v2 workstreams
(Worker, UI, Rust parser, Node client, tests, CI). Where v2 changes a v1 behaviour,
the v1 behaviour is named explicitly so the change can be reviewed and tested.

Baseline source of truth: `src/worker-v1-baseline.js` (the deployed v1 Worker,
single file, zero dependencies) and `db-schema-v1.sql` (the deployed D1 schema).

---

## 1. Performance diagnosis

### 1.1 Measured on the live v1 service

| Probe | Measured | What it should cost | Verdict |
|---|---|---|---|
| `GET /api/health` | **0.25–0.55 s** | < 0.05 s warm | Pathological — see §1.2 |
| `GET /api/inboxes/:addr/messages` | **0.43–0.67 s** | < 0.15 s warm | Slow — see §1.3 |
| Time from mail arriving to mail visible in UI | **up to ~10.6 s** | < 1 s typical | Structural — see §1.4 |

`10.6 s` is not a network measurement, it is arithmetic: the v1 UI polls on a
fixed 10 s timer (§1.4), so worst case = `10 s` (wait for next tick) +
`~0.6 s` (the list request itself). Average case is ~5.6 s. No server-side
optimisation alone fixes this; the sync model has to change (§2).

### 1.2 Why `/api/health` costs 0.25–0.55 s despite doing no work

The v1 handler for `/api/health` touches no database, parses nothing, and
returns ~80 bytes of JSON. Its latency is therefore almost entirely *platform
and transport overhead that v1 does nothing to amortise*:

1. **Cold isolate start on a low-traffic Worker.** `temp-mail` receives
   sporadic traffic. Between bursts the isolate is evicted, so a large share of
   real requests pay cold-start + module evaluation. The v1 module is small,
   but it still parses a ~10 KB single file including the entire inline UI
   string on every cold start.
2. **No cache headers, ever.** `json()` in v1 sets only `Content-Type` and
   `Access-Control-Allow-Origin`. `/api/health` and `/api/config` — responses
   that change only on deploy/config change — are never marked cacheable, so
   every probe is a full origin round trip from the client (Dhaka → nearest
   Cloudflare PoP → Worker). Nothing is served from PoP cache.
3. **No `Server-Timing`, no timing instrumentation.** v1 cannot distinguish
   client↔PoP time, PoP↔Worker time, and in-Worker time. v2 must measure
   before it claims (§8).

Consequence: health latency is the *floor* for every other endpoint. Any
endpoint doing real work (D1, parsing) starts from ~0.25 s on a cold/low-traffic
path, which is why the fixes in §5 (cacheable static/config responses) and §4.4
(keep the fetch path free of the WASM parser) matter as much as query tuning.

### 1.3 Why `/api/inboxes/:addr/messages` costs 0.43–0.67 s

This is the most expensive read in v1, for five concrete, code-level reasons:

1. **It selects full bodies for a list view.**
   ```sql
   SELECT id, address, sender, subject, text_body, html_body, created_at
   FROM mails WHERE address = ? ORDER BY id DESC LIMIT ?
   ```
   Every row ships `text_body` **and** `html_body`, each up to 50,000 chars
   (the parser's slice cap in `parseRaw`). A 20-row list can serialise
   hundreds of KB of JSON that the caller mostly never displays. Contrast
   `/api/mails`, which correctly selects `substr(text_body,1,200) AS preview`
   and never selects `html_body`. v2 unifies both on the preview shape (§3.3).
2. **Per-row OTP regex over the full body.** After the query, v1 runs
   `results.map(r => ({...r, otp: otp(r.text_body + ' ' + r.subject)}))` —
   string concatenation + `/\b(\d{4,8})\b/` over the entire text of every row,
   on the Worker's CPU-metered time, for data §1.3.1 says should not have been
   fetched. In v2 the OTP is extracted **once, at ingest**, and stored (§6.3).
3. **The address index does not cover the sort.** v1 has
   `idx_mails_address ON mails(address)`. The query is
   `WHERE address=? ORDER BY id DESC`, so SQLite finds the rows by address,
   then sorts. There is no `(address, id)` composite index (§6.1).
4. **Serial D1 round trips where they occur.** `/api/mails` (the authenticated
   sibling endpoint) does two dependent D1 queries in sequence — token →
   address, then address → mails — each a separate round trip to D1. At the
   measured health floor, each extra round trip is material. v2 collapses
   auth + list into one JOIN (§6.2).
5. **`OFFSET` pagination.** `/api/mails` uses `LIMIT ? OFFSET ?`. OFFSET scans
   and discards rows, gets slower with depth, and is unstable under concurrent
   inserts (a new mail shifts every page). Replaced by cursor pagination (§3.2).

### 1.4 Why the UI feels slow even when a single request is "only" 0.5 s

From the v1 inline UI script:

- `setInterval(() => { if (T) loadMails() }, 10000)` — fixed 10 s polling,
  regardless of whether mail is expected, the tab is visible, or the previous
  request has finished. Overlapping polls are possible.
- Every poll **re-fetches the full list** (`limit=20`, no delta parameter —
  v1 has none) and **rebuilds the whole inbox DOM**:
  `el.innerHTML = j.results.map(...).join('')`. All nodes are destroyed and
  recreated even if zero mails changed. This loses scroll position, causes
  layout thrash, and re-parses HTML for unchanged rows.
- Row HTML is built by string interpolation into `innerHTML` (with `esc()` on
  some fields). Apart from the perf cost, any field that misses escaping is an
  XSS hole with attacker-controlled input (mail subject/sender are
  attacker-controlled by definition). v2 renders with `textContent` (§5.2).
- The UI HTML itself is served from the Worker with **no `Cache-Control`**,
  so page loads also pay full origin cost (§1.2.2).
- `init()` fetches `/api/config` uncached on every page load before the domain
  selector can render — a serial blocking request in front of first paint of
  the interactive controls.

### 1.5 The ingest path is also on the clock

`email()` in v1, per incoming message:

1. `await new Response(message.raw).text()` — materialises the whole raw
   message as one JS string.
2. `parseRaw()` — synchronous, regex- and `split()`-heavy JS parsing:
   multipart split on the boundary string, per-part base64 / quoted-printable
   decoding in JS (`atob` + manual `=XX` replacement), HTML stripping by
   regex. This burns Worker CPU time proportional to message size and blocks
   the event handler.
3. Two-to-three **serial** D1 statements: `SELECT` address, conditional
   `INSERT` address, `INSERT` mail. None are batched.
4. No stored OTP, no stored preview column — every read re-derives them (§1.3).

This is the workload the Rust WASM parser (§4) and the ingest query plan
(§6.3) target. It does not affect `/api/health`, and must be kept off the
fetch path.

### 1.6 Performance budgets for v2 (acceptance targets)

Warm = isolate already started, same-PoP request. All targets p95 unless stated.

| Metric | v1 measured | v2 target |
|---|---|---|
| `GET /api/health` | 0.25–0.55 s | ≤ 0.05 s warm; cacheable (§5.1) |
| `GET /api/config` | (same class as health) | PoP-cached, `ETag`/`304` (§5.1) |
| List: `/api/mails`, `/api/inboxes/:addr/messages` | 0.43–0.67 s | ≤ 0.15 s warm, preview payload only |
| Delta sync (no new mail, `since_id` current) | n/a (full refetch) | ≤ 2 KB response, ≤ 0.15 s |
| New mail → visible in an open UI | up to ~10.6 s, ~5.6 s avg | ≤ 1 s typical, ≤ 26 s worst (long-poll timeout + one retry) |
| Single mail `GET /api/mail/:id` | unmeasured | ≤ 0.15 s warm; immutable → cacheable (§5.1) |
| Ingest CPU per 50 KB message | JS parse, unmeasured | WASM parse; JS fallback must remain functional (§4) |
| D1 statements per list request | 2 (auth path) / 1 (inbox path) | **1** (§6.2) |
| D1 statements per ingest | 2–3 serial | 1 batch (§6.3) |

Budgets are checked by the smoke/perf tests in CI (§7.4), not by assertion in
this document.

---

## 2. Long-poll: `GET /api/wait`

### 2.1 Purpose and shape

Replaces fixed-interval polling as the UI's sync mechanism. The client asks
"give me anything for this address newer than what I have, and if there is
nothing, hold the request open briefly and answer the moment something
arrives."

```
GET /api/wait?address=test123@turjaun.xyz&since_id=481&timeout=25
Authorization: Bearer <address-token>          (same auth as /api/mails)
```
The `/api/inboxes/:address/wait` alias (address in path, no auth header —
address-as-capability, consistent with the existing inbox endpoint) accepts
the same query parameters. Both forms share one implementation.

Parameters:

| Param | Required | Default | Rules |
|---|---|---|---|
| `since_id` | no | `0` | Integer ≥ 0. `0` = "I have nothing". Non-integer → `400`. **A bare `GET /api/wait` with no query string at all must work** — that is the exact call documented for agent clients in `AGENTS.md` (§2 Step 4, §4.8): with the default `since_id=0`, any already-arrived mail returns immediately, otherwise the request holds and returns when the first mail arrives. |
| `timeout` | no | `25` | Seconds. Clamped server-side to `[0, 30]`. `0` = non-blocking check (degenerates to delta sync, §3.1). |

Response `200` — new mail exists (immediately, or arrived while waiting):

```json
{
  "address": "test123@turjaun.xyz",
  "timeout": false,
  "results": [ { "id": 482, "sender": "…", "subject": "…",
                 "preview": "…", "otp": "123456", "created_at": 1763721600 } ],
  "next_since_id": 482
}
```
`results` uses the **preview row shape** (§3.3), ascending by `id` (arrival
order — the UI appends). `next_since_id` is the `id` of the last row returned.

Response `200` — timeout, nothing arrived:

```json
{ "address": "test123@turjaun.xyz", "timeout": true,
  "results": [], "next_since_id": 481 }
```
Timeout is **not** an error and not `204`: clients get a machine-checkable
body and an unchanged cursor in both branches, so the client loop is identical
for both outcomes (§5.3).

Errors: `401` unknown/missing token (auth form), `400` bad `since_id` /
`timeout`, `429` too many concurrent waits for one address (§2.4).

### 2.2 Server implementation (Worker + D1, no new infra)

v2 ships long-poll on the infrastructure that already exists — no Durable
Object is required for v2.0:

```text
deadline = now + timeout
loop:
  rows = SELECT preview-cols FROM mails
         WHERE address = ? AND id > ? ORDER BY id ASC LIMIT 50   -- §6 index
  if rows.nonEmpty: return { timeout:false, results:rows, next_since_id:last.id }
  if now >= deadline or request.signal.aborted: return { timeout:true, … }
  await sleep(pollInterval)     -- 750 ms, jittered ±150 ms
```
Rules:

- **First check is immediate.** If mail is already waiting, `/api/wait` is
  exactly as fast as delta sync — the common case after a page reload.
- **Internal poll interval 750 ms** against D1 using the `(address, id)`
  index (§6.1). This is a cheap indexed point query, not the v1 list query.
  Expected time-to-visible for mail arriving mid-wait is therefore
  ingest time + ≤ ~0.9 s, meeting the §1.6 target without push infrastructure.
- **Respect `request.signal`** — if the client disconnects (tab closed,
  navigation, UI aborts and restarts its loop), stop querying D1 immediately.
  Orphaned loops burning D1 reads are the main cost risk of this design.
- **Cap `timeout` at 30 s.** Keeps the request comfortably inside Worker
  request-duration behaviour for held fetch requests, leaves margin for the
  final query + response, and bounds how long a stale cursor can be held.
  Clients simply re-issue (§5.3); re-issue is cheap because of §3.1 + §5.1.
- **Read-your-writes:** the wait loop queries D1's primary (the default for
  D1 reads in a Worker binding). Do not route these reads to a replica /
  read-optimised session: a mail inserted by `email()` must be visible to the
  very next wait-loop iteration, or the 1 s target is void.
- One in-flight wait counts against the address's rate budget (§2.4), not
  per internal D1 poll — internal polls never leave the Worker.

### 2.3 Upgrade path (not v2.0): Durable Object push

If measured wait-loop D1 reads or the ~0.9 s floor become a problem, the
designed upgrade is a per-address (or sharded) Durable Object `MailboxHub`:
`email()` notifies the DO on insert, the DO holds WebSocket / long-poll
subscribers and wakes them in < 200 ms, D1 remains the source of truth and
the DO holds no mail data. The `/api/wait` **contract in §2.1 does not
change** when this lands — only the server internals do — so UI and Node
clients written against v2.0 need no changes. This is deliberately deferred:
it adds a new binding, a new deploy unit, and free-tier accounting, none of
which are needed to beat 10.6 s by an order of magnitude.

### 2.4 Abuse and cost controls

- Auth form (Bearer token) is the preferred form; the address-as-capability
  form is retained only for parity with the existing inbox endpoint.
- **One concurrent `/api/wait` per address per client cursor** is the client
  contract (§5.3). Server-side, if an address exceeds a small concurrent-wait
  threshold, excess waits get `429` with `Retry-After: 5`. Threshold and
  storage (in-isolate map is best-effort; a D1/KV counter is *not* worth a
  round trip per wait) are implementation details, but the `429` shape is
  contractual.
- `timeout=0` checks are ordinary reads and are not rate-limited beyond
  global Worker limits.

---

## 3. Incremental sync, cursor pagination, and payload shapes

### 3.1 Incremental sync via `since_id`

`mails.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` — monotonically increasing,
never reused, and already the ordering key everywhere in v1. v2 makes it the
**sync cursor**:

- New optional parameter on both list endpoints:
  `GET /api/mails?since_id=481`, `GET /api/inboxes/:addr/messages?since_id=481`.
- Semantics: return only rows with `id > since_id`, ordered `id ASC`
  (arrival order) when `since_id` is present. Without `since_id`, behaviour
  is the classic newest-first list (§3.2) — v1 clients keep working.
- Every list/wait response carries `next_since_id`: the maximum `id`
  returned, or the request's `since_id` unchanged if no rows were returned.
  Clients persist it (memory + `localStorage`, alongside the address/token
  v1 already persists) and send it on the next request.
- **Payload win:** an up-to-date client syncing gets
  `{ "results": [], "next_since_id": 481 }` — tens of bytes instead of the
  full 20-row list — plus a `304` fast path when an `ETag` is supplied (§5.1).
- **Deletions and expiry:** `since_id` sync is append-only. A mail deleted
  via `DELETE /api/mail/:id` or expired by the hourly cron will not be
  signalled as a tombstone in v2.0; the UI reconciles by doing one full
  newest-first refresh on (a) page load, (b) manual Refresh, and (c) every
  20th wait cycle. This limitation is accepted and documented here so no
  client assumes delta sync is a complete replica.
- OTP and preview are **columns-derived at ingest** (§6.3), so delta rows
  need no per-read computation.

### 3.2 Cursor pagination (replaces `OFFSET`)

For newest-first browsing of history:

```
GET /api/mails?limit=20&before_id=482
→ { "results": [ …preview rows, id DESC… ],
    "next_before_id": 463, "has_more": true, "next_since_id": 501 }
```
- `before_id` = return rows with `id < before_id`, `ORDER BY id DESC`,
  `LIMIT limit+1`. The extra row decides `has_more` and is not returned;
  `next_before_id` is the smallest returned `id`. First page omits
  `before_id`. This maps 1:1 onto the `(address, id DESC)` index (§6.1):
  no scan-and-discard, stable if new mail inserts mid-pagination (new rows
  have larger ids and can never enter an in-progress backward walk).
- `limit`: default `20`, clamped `[1, 50]` (same clamp as v1).
- `OFFSET` is **deprecated** in v2, not silently broken: the cursor form
  above is the only supported way to page deeply, but a request carrying
  only the legacy `limit`/`offset` pair (as documented for agent clients
  in `AGENTS.md` §4.4, which uses `limit=20&offset=0`) must still return
  the correct page — the server may implement it on top of the cursor
  query internally. New clients must not use `offset`; docs for new
  clients must not mention it.
- The opaque-cursor alternative (base64-wrapped id) was rejected: the raw
  integer id is already the public identifier used by `/api/mail/:id`, so
  wrapping it adds opacity without adding security or flexibility.

### 3.3 One preview row shape everywhere

List, delta, wait, and pagination responses all return this row — and
**never** `text_body` / `html_body`:

```json
{ "id": 482, "address": "test123@turjaun.xyz", "sender": "a@b.c",
  "subject": "Your code", "preview": "Your code is 123456…",
  "otp": "123456", "created_at": 1763721600 }
```
- `preview` = first 200 chars of text body, produced at ingest or by
  `substr(text_body,1,200)` in SQL — never by shipping the body to the
  client and truncating there (v1's inbox endpoint anti-pattern, §1.3.1).
- `otp` = value stored at ingest (§6.3), or `null`. No read-time regex.
- Full bodies are available only from `GET /api/mail/:id`, fetched on
  demand when a user actually opens a message (§5.2).

### 3.4 Compatibility

All v1 endpoints and required fields remain. v2 changes are additive
(`next_since_id`, `has_more`, `timeout`, …) except: (a) the inbox list
endpoint stops returning full bodies **by default** — the one deliberate
breaking change, justified in §1.3 and §3.3, and the reason this is a v2.
Escape hatch, required for compatibility with the agent workflow in
`AGENTS.md` (§2 Steps 5–6), which extracts verification links from
`text_body`/`html_body` after a wait: `?full=1` on
`/api/inboxes/:addr/messages` explicitly opts back into full bodies for
that one call (small `limit` expected; this mode is for agents fetching a
handful of just-arrived messages, never for the UI list). The `otp` field
is present in both modes, so OTP-only clients never need `full=1`;
(b) `offset` is deprecated but still honoured (§3.2). The Node client
(`packages/node-client`) targets the v2 shapes and must not re-introduce
full-body list calls by default.

---

## 4. Rust WASM MIME parser

### 4.1 Why, and why only on the ingest path

JS `parseRaw()` (§1.5) is the only CPU-bound, size-proportional work in the
system. A Rust parser compiled to WebAssembly gives: correct MIME handling
(nested multipart, RFC 2047 encoded-word headers, charset decoding) that the
hand-rolled v1 parser approximates, at a fraction of the CPU per byte, with
memory-safe parsing of **attacker-controlled bytes** — mail input is
untrusted by definition, and v1 parses it with ad-hoc regex/split code.

The parser is used **only in `email()`**. It is never imported, instantiated,
or even loaded on the `fetch` path, so `/api/health` and list reads pay zero
WASM cost (§1.2, §1.6). This separation is a hard requirement, enforced by
module layout (§4.3) and a bundle check in CI (§7.3).

### 4.2 Contract

Crate: `rust/mail-parser/` (in this repo). Built with the Rust toolchain in
GitHub Actions only (§7) — **there is no local `rustc` in the development
environment, and no step of local development may require one** (§4.5).

```text
parse_mime(input: &[u8]) -> Result<ParsedMail, ParseError>   (Rust)
parseMime(bytes: Uint8Array) -> ParsedMail                    (wasm-bindgen export)
```
```ts
interface ParsedMail {
  subject: string;            // RFC 2047 decoded, "" if absent
  from: string;               // address portion, "" if unparseable
  text: string;               // text/plain parts concatenated, ≤ 50_000 chars
  html: string;               // text/html parts concatenated, ≤ 50_000 chars
  otp: string | null;         // first \b\d{4,8}\b in subject+text, ingest use
  rawSize: number;            // input length in bytes
}
```
- Input is **raw bytes** (`message.raw` read as `ArrayBuffer`), not a
  pre-decoded JS string as in v1 — charset and transfer decoding happen
  inside Rust (`mail-parser` crate for MIME structure, `encoding_rs` for
  charsets, `base64` / `quoted-printable` handling within the parser crate's
  pipeline). The 50,000-char output caps from v1 are preserved exactly, so
  stored data does not change shape.
- Errors are values, not traps: malformed mail returns the best-effort
  partial parse the crate can produce; a hard `Err` is caught by the JS
  shim and routed to the fallback (§4.4). A WASM trap must never lose a
  mail — `email()`'s fallback insert (v1 already stores a placeholder row
  on parse failure) remains the last resort.
- The same crate is the parser for the Node.js side: the "Rust binary used
  from Node" surface is this core compiled for Node consumption (WASM
  package under `packages/`, built by the same CI job, §7.2), so the Worker
  and Node clients extract subject/text/OTP identically. One parser, one
  fixture suite (§4.6), two hosts. A native (non-WASM) binary target may be
  added for offline tooling but is not on the Worker's critical path.

### 4.3 Integration in the Worker

- Build output: `mail_parser_bg.wasm` + JS glue, produced by `wasm-pack
  build --target bundler` (or `wasm-bindgen` directly) in CI, committed to
  the build as a **CI artifact, not a repo binary** (§7.2).
- The Worker entry imports the glue **statically but lazily**: the fetch
  module graph does not reference the parser; the `email()` handler does a
  dynamic `import()` of the parser module on first mail in that isolate and
  caches the initialised instance at module scope (instantiate once per
  isolate, reuse thereafter). Wrangler is configured to bundle the `.wasm`
  as a module (` CompiledWasm ` rule / `wasm_modules` as appropriate for
  the pinned Wrangler version — pinned in CI, §7.1).
- Size budget: **≤ 150 KB gzipped** for the `.wasm`. CI fails the build if
  the budget is exceeded (§7.3); exceeding it requires an architecture
  amendment, not a silent bump. Release profile: `opt-level = "s"`,
  `lto = true`, `panic = "abort"`, `wasm-opt -Oz` in CI.

### 4.4 Fallback to the JS parser — mandatory, tested

```js
async function parseMail(bytes) {
  try {
    const wasm = await loadParser();            // dynamic import, cached
    return wasm.parseMime(bytes);
  } catch (_) {
    return parseRaw(new TextDecoder().decode(bytes));  // v1 parser, verbatim
  }
}
```
- `parseRaw` from v1 is carried into v2 **unchanged** as the fallback. It is
  known-good on the traffic v1 has actually received; correctness parity is
  defined as "WASM result wins, JS result is the safety net", not bit-parity
  between the two (the WASM parser is intentionally *more* correct on
  encoded-word / nested-multipart mail — those diffs are improvements and
  are catalogued in the fixture suite, §4.6).
- Fallback triggers: WASM artifact missing (local dev without a CI build,
  §4.5), instantiation failure, or a thrown trap/`Err` from `parseMime`.
- A `parser: "wasm" | "js"` field is logged per ingest (§8) so fallback
  usage in production is visible; silent permanent fallback is a bug.

### 4.5 Local development without Rust

No local `rustc` exists and none will be installed. Therefore:

- `wrangler dev` and the JS test suite run against the **JS fallback by
  default**. Local dev is fully functional, just slower at ingest.
- To dev against WASM, a developer downloads the `.wasm` artifact from the
  latest green CI run (§7.2) into the expected path; no local compilation.
- Nothing in `package.json` scripts may invoke `cargo` / `wasm-pack`.

### 4.6 Parser tests

- A shared fixture corpus (raw `.eml` bytes + expected `ParsedMail` JSON):
  plain text, HTML-only, multipart/alternative, multipart/mixed, base64 and
  quoted-printable bodies, RFC 2047 subjects, non-UTF-8 charsets
  (ISO-8859-1, Shift_JIS), nested multipart, malformed boundary, 100 KB+
  message (cap behaviour), OTP in subject vs body.
- The corpus runs three ways in CI: Rust unit tests (native target), WASM
  under Node, and the JS fallback under Node — the JS run documents known
  divergences instead of asserting equality where §4.4 allows improvement.

---

## 5. Caching, ETags, and the UI rendering strategy

### 5.1 HTTP caching and ETags

| Response | Headers (v2) | Rationale |
|---|---|---|
| `GET /` (UI HTML) | `Cache-Control: public, max-age=300, stale-while-revalidate=60`, `ETag: "<deploy-tag>"` | UI changes only on deploy; PoP can serve it without hitting the Worker (§1.4). |
| `GET /api/health` | `Cache-Control: public, max-age=10`, body unchanged | Health is a liveness probe, not live data; 10 s of PoP caching removes it from the cold-Worker path for most probes. |
| `GET /api/config`, `/api/domains` | `Cache-Control: public, max-age=300`, `ETag: "<hash of domains+ttl>"` | Config changes only with vars/deploy. UI `init()` (§1.4) becomes a `304` or a cache hit. |
| List / delta / wait `200` | `Cache-Control: private, no-cache`, `ETag: "<address>:<max_id>:<count>"`, `Vary: Authorization` | `no-cache` = may store, must revalidate. With `If-None-Match`, an unchanged delta is a **`304` with no body and — critically — the server still must run the cheap existence check, but skips serialising rows**. Never `public`: responses are per-address/token. |
| `GET /api/mail/:id` | `Cache-Control: private, max-age=3600, immutable`, `ETag: "<id>:<raw_size>"` | A stored mail never changes (only deleted/expired). Opening the same message repeatedly is free after the first fetch. `404` after expiry is the correct invalidation. |
| `POST /api/new_address`, `DELETE …` | `Cache-Control: no-store` | Mutations are never cached. |

Implementation notes:

- List ETag is derived from data the index already returns
  (`MAX(id)`, `COUNT(*)`) — computing it must not add a query (§6.2 folds
  it into the single list statement's result handling or a covering-index
  aggregate on the same statement via `batch`, counted against the §1.6
  statement budget only if it stays one round trip).
- `ETag` comparison is strong and exact-match on `If-None-Match`; on match
  for a delta request, return `304` **only if** `since_id` also matches the
  ETag's `max_id` — a mismatched pair means a confused client, serve `200`.
- CORS: add `ETag` to `Access-Control-Expose-Headers` and allow
  `If-None-Match` / `Authorization` on requests, so browser and Node
  clients can actually use revalidation cross-origin.
- All JSON responses gain `Server-Timing` (§8); cached/`304` responses are
  how the §1.6 warm targets are met, so tests assert these headers (§7.4).

### 5.2 UI rendering strategy

The v2 UI keeps v1's zero-framework, single-page shape (it is served by the
Worker and must stay dependency-free) and changes *how* it syncs and paints:

1. **Sync = long-poll loop, not a timer** (§5.3). No `setInterval` remains.
2. **Keyed, incremental DOM.** The inbox is a `Map<id, HTMLElement>`.
   Delta/wait results are applied as operations: *prepend* new rows
   (newest-first view) built in a `DocumentFragment` (one reflow per batch),
   *remove* rows the server/full-refresh says are gone, *leave every other
   node untouched*. No wholesale `innerHTML` rebuild — scroll position,
   selection, and the open message survive a sync.
3. **Safe construction.** Rows are built with `document.createElement` and
   `textContent` for `sender`, `subject`, `preview`, `otp`. No mail-derived
   string ever reaches `innerHTML`. (v1's interpolated `innerHTML` + manual
   `esc()` is removed, not extended.) Static page chrome may remain HTML.
4. **Preview first, body on demand.** The list renders from preview rows
   (§3.3) only. Clicking a row fetches `/api/mail/:id` (immutable-cached,
   §5.1) and renders the body into the reading pane; bodies are kept in a
   small in-memory LRU (≤ 20) so back-and-forth navigation is instant.
   The OTP, already in the preview row, is shown in the list itself with a
   copy button — the single most common temp-mail task should not require
   opening the message at all.
5. **First paint without a blocking config fetch.** Domains are rendered
   from the cached/`ETag` config (§5.1); on repeat visits the selector is
   populated from `localStorage` immediately and revalidated in parallel
   with the first sync, instead of v1's serial `init()` gate.
6. **Restraint budgets:** inbox DOM capped at 100 rows (older rows load via
   cursor pagination §3.2 on scroll-to-bottom / "Load older" button);
   rendering a 50-row delta must be a single fragment insertion.

### 5.3 The client sync loop (UI and Node client share this algorithm)

```text
state: since_id (persisted), abortController
loop while page visible / client running:
  try:
    res = GET /api/wait?since_id&timeout=25   (AbortController, no extra timer)
    if res.timeout == false: applyDelta(res.results); since_id = res.next_since_id; continue immediately
    if res.timeout == true:  continue immediately        // server held 25 s; that's the idle cadence
  catch network/abort:
    backoff = min(30s, 1s * 2^n) with jitter; sleep; continue
on visibilitychange -> hidden: abort in-flight wait
on visibilitychange -> visible: restart loop immediately
on address/token change: abort, reset since_id from a full refresh, restart
```
- Idle request rate is ~1 per 25 s per open tab (vs v1's 1 per 10 s with a
  full payload) and idle payload is ~100 bytes (vs a full list).
- `document.visibilitychange` handling removes v1's background-tab polling
  entirely — hidden tabs issue zero requests.
- The Node client (`packages/node-client`) implements the same loop as an
  async iterator / `EventEmitter` (`waitForMail(address, { timeout })`
  wraps one `/api/wait` call; `watch(address)` wraps the loop), so API
  consumers get the same latency profile as the UI.

---

## 6. D1 query and index plan

### 6.1 Indexes

v1 indexes: `idx_mails_address(address)`, `idx_mails_created(created_at)`,
`idx_addresses_token(token)`, `idx_addresses_address(address)` (redundant —
`address` is already `UNIQUE`, which creates its own index).

v2 migration (`db-schema-v2.sql`, applied by CI, §7.3):

```sql
-- The one hot index: every list / delta / wait / page query is
-- "address = ? [AND id >/< ?] ORDER BY id" — serve it entirely from index.
CREATE INDEX idx_mails_address_id
  ON mails(address, id DESC)
  INCLUDE (sender, subject, created_at);

-- Cron expiry stays indexed without the old standalone created index.
CREATE INDEX idx_mails_created_id ON mails(created_at, id);

DROP INDEX idx_mails_address;      -- subsumed by idx_mails_address_id
DROP INDEX idx_mails_created;      -- subsumed by idx_mails_created_id
-- idx_addresses_token / the UNIQUE(address) index are kept as-is:
-- token→address is a point lookup and already optimal.
```
- `INCLUDE (sender, subject, created_at)` makes the preview query
  **index-only** for its non-body columns. `preview`/`otp` come from stored
  columns (§6.3) — if the migration adds `preview`/`otp` columns, they join
  the `INCLUDE` list; the design constraint is: *the list query never opens
  the table row for `text_body`/`html_body`*.
- Every v2 query in §6.2 is validated with `EXPLAIN QUERY PLAN` in tests:
  the expected plan is `SEARCH mails USING INDEX idx_mails_address_id`,
  with no `USE TEMP B-TREE FOR ORDER BY`. A plan regression fails CI (§7.4).
- Migration is additive-then-drop, runs inside the deploy workflow against
  the remote D1 (`temp-mail-db`, id bound in Wrangler config), and is
  idempotent (`IF EXISTS` / `IF NOT EXISTS`) so re-runs are safe.

### 6.2 Read queries (one round trip each)

**Authenticated list / delta / page** — auth folded in, replacing v1's two
serial queries:
```sql
SELECT m.id, m.sender, m.subject, m.preview, m.otp, m.created_at
FROM addresses a JOIN mails m ON m.address = a.address
WHERE a.token = ?                       -- auth
  AND (:since_id IS NULL OR m.id > :since_id)
  AND (:before_id IS NULL OR m.id < :before_id)
ORDER BY m.id DESC  -- (ASC when since_id is set and before_id is not)
LIMIT :limit_plus_one;
```
(The shipped SQL is generated per mode — delta vs page — rather than
sending nullable-parameter SQL that defeats the index; the shape above is
the contract, not literal production SQL with `IS NULL` branches.)

**Inbox (address-as-capability) list / delta:** the same statement minus
the JOIN, keyed directly on `m.address = ?`.

**Wait-loop existence query** (the §2.2 inner poll — the cheapest query in
the system, run every ~750 ms per active waiter):
```sql
SELECT id FROM mails WHERE address = ? AND id > ? ORDER BY id ASC LIMIT 1;
```
On a hit, the full preview delta (§3.1 query, `id ASC`) is fetched once.
On a miss, nothing else is fetched. Both are index-only on
`idx_mails_address_id`.

**Single mail:** `SELECT … WHERE id = ?` — primary-key lookup, unchanged
from v1, now with the §5.1 immutable caching in front of it.

### 6.3 Write queries (ingest and lifecycle)

Ingest becomes **one `env.DB.batch()` round trip** (vs v1's 2–3 serial):

```sql
-- 1. Ensure the address row exists (catch-all mail to a never-created
--    address must still be stored, as in v1):
INSERT OR IGNORE INTO addresses (address, token) VALUES (?, ?);
-- 2. Store the mail, with read-time work pre-computed:
INSERT INTO mails (address, sender, subject, text_body, html_body,
                   preview, otp, raw_size)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);
```
- Migration adds `preview TEXT` and `otp TEXT` columns to `mails`
  (nullable; v1 rows backfill lazily — reads fall back to
  `COALESCE(preview, substr(text_body,1,200))` and `otp` may be `null` for
  pre-v2 rows; no mass `UPDATE` in the migration).
- `preview`/`otp` are computed by whichever parser ran (§4) at ingest.
  This is what removes §1.3.2's per-read regex and §1.3.1's body shipping.
- `POST /api/new_address` is unchanged in shape (one `INSERT`, `UNIQUE`
  collision → return existing token, as v1).
- **Scheduled cleanup** (hourly cron, as v1) deletes in **bounded chunks**
  — `DELETE … WHERE created_at < ? LIMIT 1000`, repeated via `waitUntil`
  until fewer than 1000 rows are affected — instead of v1's two unbounded
  `DELETE`s, so a large expiry backlog cannot blow the cron's limits or
  lock-step the database. Address expiry keeps v1 semantics.

### 6.4 What is deliberately not changing

- No new database, no KV, no R2, no Queues in v2.0. D1 + Worker remain the
  whole backend; every v2 win above is query shape, payload shape, caching,
  or sync model — not new infrastructure. (§2.3 is the only named exception
  and it is deferred.)
- Table names, `AUTOINCREMENT` ids, token model, 24 h TTL
  (`MAIL_TTL_HOURS`), and the hourly cron schedule are unchanged.

---

## 7. Deployment via GitHub Actions CI

### 7.1 Principles

- **CI is the only place Rust is compiled and the only place production
  deploys originate.** No local `rustc` (§4.5), no manual dashboard code
  edits (v1 was deployed by dashboard paste / ad-hoc API calls; v2 forbids
  both for production), no `wrangler deploy` from a workstation to prod.
- Repository: the GitHub repo for this project under the user's
  `turjaun…` account (repo creation/push is a separate workstream; this
  document specifies the workflows that repo must contain).
- Secrets live in GitHub Actions secrets / Cloudflare, never in the repo:
  `CLOUDFLARE_API_TOKEN` (scoped: Workers Scripts Edit, D1 Edit, Workers
  Routes Edit, Email Routing Rules Edit, Zone Read — the same scope used
  for the v1 API deploy), `CLOUDFLARE_ACCOUNT_ID`. Wrangler config in the
  repo contains only non-secret values (names, D1 database *id*, vars
  `DOMAINS=turjaun.xyz`, `MAIL_TTL_HOURS=24`, compatibility date, cron
  `0 * * * *`).

### 7.2 Workflow: `build-wasm.yml` (on changes under `rust/`, or reusable)

```text
runs-on: ubuntu-latest
- actions/checkout
- dtolnay/rust-toolchain@stable with targets: wasm32-unknown-unknown
- actions/cache for ~/.cargo + rust/target (keyed on Cargo.lock)
- install wasm-pack (prebuilt binary release, not cargo install — speed)
- wasm-pack build rust/mail-parser --target bundler --release
- run §4.6 fixture suite: cargo test (native) + WASM-under-Node runner
- actions/upload-artifact: mail-parser-wasm  (wasm + glue + package.json)
```
The Node-consumable package (§4.2) is published from this same artifact
(build once, consume twice — Worker bundle and `packages/node-client`
tests both take the parser from this artifact in CI).

### 7.3 Workflow: `deploy.yml` (push to `main`; `workflow_dispatch` for manual)

```text
1. checkout
2. setup-node (pinned LTS) → npm ci
3. JS tests + parser fixture suite against the JS fallback (§4.6)
4. download-artifact: mail-parser-wasm  (from build-wasm, same run or
   latest green run on this branch) — if the artifact is absent, the
   deploy FAILS rather than silently shipping fallback-only ingest,
   unless the dispatch input `allow_js_fallback_only=true` is set
5. bundle checks:
   - .wasm gzip size ≤ 150 KB (§4.3)
   - fetch-path module graph contains no parser import (§4.1)
6. apply D1 migrations: wrangler d1 execute temp-mail-db --remote
   --file db-schema-v2.sql        (idempotent, §6.1)
7. wrangler deploy                (API token from secrets; deploys Worker
   + cron trigger + bindings from wrangler config)
8. smoke tests (§7.4) against https://temp-mail.turjaun.workers.dev
9. on smoke failure: wrangler rollback to the previous deployment and
   fail the job loudly — a red pipeline with v1/v2-old still live is the
   designed failure mode, never a half-deployed prod
```

### 7.4 Workflow: `ci.yml` (pull requests) and smoke/perf tests

PRs run steps 2–5 of §7.3 plus `EXPLAIN QUERY PLAN` assertions (§6.1)
against a local/ephemeral D1 (Wrangler/miniflare) — no prod credentials,
no deploy.

Post-deploy smoke (also runnable on a schedule as an uptime probe):

```text
GET  /api/health                       → 200, { ok:true }, cache headers present (§5.1)
GET  /api/config                       → 200, ETag present; repeat with If-None-Match → 304
POST /api/new_address {name: smoke-<rand>} → 200, address @turjaun.xyz + token
GET  /api/mails (Bearer)               → 200, results: [], next_since_id present
GET  /api/wait?since_id=0&timeout=0     → 200, timeout:true (empty inbox)
GET  /api/inboxes/<addr>/messages      → 200, preview shape, NO text_body/html_body fields
timing: health and list p95 within §1.6 budgets over 20 warm samples
```
End-to-end mail delivery (send real mail → appears via `/api/wait`) is a
**manual / scheduled** test, not a PR gate: it depends on external senders
and Email Routing propagation, and gating merges on it would make CI
flaky. It is run after each production deploy by the operator/agent and
recorded with the deploy.

### 7.5 Environments and rollback

- One production Worker (`temp-mail`) + optionally a `temp-mail-staging`
  Worker + separate D1 for pre-prod dispatches (`workflow_dispatch` with
  an `environment` input). Catch-all Email Routing points only at prod;
  staging is tested via its API/UI directly, never by live mail.
- Rollback is a Worker rollback (step 9) — D1 migrations are additive and
  are *not* rolled back; v2 schema must remain readable by the previous
  Worker version (hence nullable new columns and `COALESCE` reads, §6.3).

---

## 8. Observability

v1 has `console.error` on ingest failure and nothing else. v2 adds, cheaply:

- `Server-Timing: app;dur=<ms>, d1;dur=<ms>` on API responses (in-Worker
  timings only — the client measures the rest), so §1.6 budgets can be
  verified from any client without dashboard access.
- Structured `console.log` JSON per request, sampled for reads, always on
  for ingest and errors: `{ route, status, ms, d1_ms, rows, parser, address_hash }`.
  `address_hash` (truncated SHA-256) — never log raw tokens, never log
  mail bodies or subjects.
- Ingest logs include `parser: "wasm" | "js"` (§4.4) and `raw_size`;
  a production fallback rate above zero for a sustained period is an
  alertable regression, not background noise.
- Wait-loop metrics per request (not per internal poll): `wait_ms`,
  `wait_result: "hit" | "timeout" | "aborted"`. Aborted waits spiking
  means clients are misbehaving per §5.3, not that the server is slow.

---

## 9. Summary of changes v1 → v2

| Area | v1 | v2 |
|---|---|---|
| Sync model | 10 s fixed poll, full list | Long-poll `/api/wait` (25 s hold, 750 ms indexed check), delta via `since_id` |
| Worst-case mail visibility | ~10.6 s | ≤ ~1 s typical |
| List payload | Full `text_body` + `html_body` (inbox endpoint) | Preview rows only, one shape everywhere (§3.3) |
| OTP | Regex per row per read | Extracted once at ingest, stored column |
| Pagination | `LIMIT`/`OFFSET` | Cursor (`before_id`, `limit+1` → `has_more`) |
| Auth + list | 2 serial D1 queries | 1 JOIN |
| Ingest | JS parse, 2–3 serial D1 writes | Rust WASM parse (JS fallback), 1 `DB.batch()` |
| Indexes | `(address)`, `(created_at)` | `(address, id DESC) INCLUDE(…)`, `(created_at, id)` |
| Caching | None | PoP cache for UI/health/config; `ETag`/`304` for lists; immutable single-mail |
| UI rendering | `innerHTML` rebuild every poll | Keyed incremental DOM, `textContent`, visibility-aware loop |
| Deploy | Dashboard paste / ad-hoc API | GitHub Actions only: CI builds Rust→WASM, migrates D1, deploys, smokes, rolls back |
| Local dev | n/a | No `rustc` required; JS fallback default, WASM artifact from CI |

