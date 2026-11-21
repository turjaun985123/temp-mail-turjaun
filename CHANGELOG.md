# Changelog

All notable changes to Temp Mail (`turjaun.xyz`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Live service: https://temp-mail.turjaun.workers.dev ·
Repository: `turjaun985123/temp-mail-turjaun`

## [Unreleased]

Known gaps between the v2 codebase and the deployed Worker. These are
tracked here so no reader mistakes code that exists in the repository for
behaviour that is live in production:

- **Rust WASM parser not yet wired into the deployed Worker — JS fallback
  active.** The Rust `mail-parser` crate and its CI build exist (see
  [2.0.0]), but ingest in the deployed Worker still runs the v1 JavaScript
  parser (`parseRaw`) as the active path. The WASM parser becomes the
  primary ingest parser only once it is dynamically loaded by the
  `email()` handler per `docs/ARCHITECTURE.md` §4.3–§4.4; until then the
  fallback is the production parser, not an emergency path.
- **SSE module is opt-in and not routed.** `src/sse.js` provides a
  Server-Sent Events alternative to `GET /api/wait`, but no route in the
  deployed Worker exposes it. `/api/wait` long-poll remains the only
  supported wait mechanism; SSE is not faster (both discover mail by
  polling D1 server-side) and costs more held-open request duration.
- **`INCLUDE` index clause pending D1 confirmation.** The ideal form of
  the composite index in `docs/ARCHITECTURE.md` §6.1 is
  `idx_mails_address_id ON mails(address, id DESC) INCLUDE (sender, subject, created_at)`,
  which would make preview queries index-only. The shipped migration
  (`db/migrate-v1-to-v2.sql`) creates the plain composite index without
  `INCLUDE`, because the SQLite builds in this project's local/CI
  verification environment reject `INCLUDE` syntax. The index can be
  dropped and recreated in the `INCLUDE` form under the same name once a
  D1 build is confirmed to accept it; filter/sort plans are identical
  either way.

## [2.0.0] - 2026-11-21

v2 is a performance and usefulness release on the same stack as v1 —
Cloudflare Email Routing → Cloudflare Worker → D1 (SQLite) — with no new
infrastructure. Its headline fix is mail-visibility latency: see Fixed.

### Added

- **Long-poll endpoint `GET /api/wait`.** One request holds open
  (default 25 s, clamped to a 30 s maximum) and returns the moment mail
  with `id > since_id` arrives, or `200` with `"timeout": true` when the
  wait elapses — a timeout is not an error. Auth is a per-inbox Bearer
  token or an `address` parameter. One wait replaces dozens of polls;
  this is now the only supported way to wait for mail.
- **Cursor pagination on `GET /api/mails`** — `since_id` (only mail with
  `id > since_id`, for incremental sync) and `before_id` (only mail with
  `id < before_id`, for drift-free history paging). List/wait responses
  carry cursor bookkeeping (`latest_id` / `next_before_id` in the API
  contract; `next_since_id` in the architecture contract), so an
  up-to-date client syncs in tens of bytes instead of re-downloading the
  whole inbox, and cursor pages do not drift when new mail arrives
  mid-browse. Combining `offset` with a cursor in one request is a `400`.
- **ETag / conditional requests (`304 Not Modified`)** on
  `GET /api/mails`, `GET /api/inboxes/:address/messages`,
  `GET /api/mail/:id`, and `GET /api/config` / `GET /api/domains`, with
  per-endpoint `Cache-Control` (lists revalidate, single mail is
  immutable-cached, config is PoP-cached, health/wait/mutations are
  `no-store`). v1 sent no caching headers at all.
- **Verification link extraction.** In addition to the v1 `otp` field,
  the Worker now extracts verification / confirmation links from a
  message's text and HTML bodies (`extractLinks`), so clients and agents
  handling link-based verification do not have to scrape bodies
  themselves. OTP extraction was also improved to prefer a 4–8 digit code
  near a keyword (`verification code`, `security code`, `one-time`,
  `otp`, `passcode`, `pin`, `code`) over an arbitrary number in the body.
- **Rust WASM mail-parser crate** (`rust/mail-parser/`). A Rust crate
  compiled to WebAssembly (`wasm32-unknown-unknown`, built with
  `wasm-pack` in CI only — no local `rustc` is required or used) exposing
  `parseMime(bytes) -> { subject, from, text, html, otp, rawSize }`.
  It handles nested multipart, RFC 2047 encoded-word headers, charset
  decoding, and base64 / quoted-printable bodies, and parses
  attacker-controlled bytes in memory-safe Rust. It is used only on the
  ingest path — the fetch path pays zero WASM cost — with the v1 JS
  parser kept as a mandatory, tested fallback, and a shared `.eml`
  fixture corpus runs against the Rust, WASM-under-Node, and JS parsers.
  The `.wasm` is size-budgeted at ≤ 150 KB gzipped in CI.
  See the [Unreleased](#unreleased) note: the crate is built, but the
  deployed Worker still ingests via the JS fallback.
- **Node.js client SDK** — `@turjaun/temp-mail-client`
  (`packages/node-client/`): zero dependencies, Node 18+, ESM.
  `TempMailClient` provides `createInbox()`, `waitForMail()` /
  `waitForOTP()`, and a `watch()` loop implementing the same long-poll
  sync algorithm as the web UI, so scripts get the UI's latency profile
  without hand-rolling polling.
- **`AGENTS.md`** at the repository root: the mandatory instruction file
  for AI agents using the API — create an inbox → save `address` +
  `token` → submit the address → wait with one `GET /api/wait` per cycle
  (never timer-poll) → read the `otp` field (fall back to body, then
  verification links) → delete consumed mail and let the inbox expire.
  Includes the full endpoint table, an error-action table, mandatory
  rate/etiquette rules, and a complete worked OTP signup example.
- **Webhooks module** (`src/webhooks.js`). Zero-dependency outbound
  webhook delivery for a `mail.received` event, fired via
  `ctx.waitUntil()` so delivery never delays or fails the mail insert.
  It is a no-op when `WEBHOOK_URL` is unset; delivery never throws.
- **SSE module** (`src/sse.js`). A zero-dependency Server-Sent Events
  alternative to `/api/wait` with an honest in-code comparison of the
  two mechanisms. Opt-in only — see the [Unreleased](#unreleased) note:
  it is not routed in the deployed Worker.
- **Rate-limit module** (`src/rate-limit.js`). A zero-dependency
  fixed-window limiter (`createRateLimiter()`, `getClientKey()`,
  `rateLimitResponse()`, `RECOMMENDED_LIMITS`) with a documented JSON
  `429 {"error":"Rate limited"}` + `Retry-After` contract. Counters are
  in-memory and per-isolate, so limiting is best-effort abuse damping,
  explicitly not a security boundary or a substitute for Cloudflare WAF
  rate-limiting rules; a Durable Object upgrade path is documented in
  the module.
- **Performance test** (`tests/perf.mjs`). Zero-dependency script that
  samples `/api/health`, `/api/config`, `POST /api/new_address`,
  `/api/inboxes/:address/messages`, and `/api/wait`, reports
  min / median / p95 / max per endpoint, and prints a verdict against
  the measured v1 baselines. The integration suite in
  `tests/api.test.mjs` remains zero-dependency (`node:test`); its
  `/api/wait` tests skip rather than fail against a v1 server.
- **GitHub Actions CI.** Three workflows under `.github/workflows/`:
  `ci.yml` (PR checks — JS tests, parser fixtures, bundle and
  query-plan checks, including `EXPLAIN QUERY PLAN` assertions on the
  composite index), `build-wasm.yml` (installs the stable Rust toolchain
  with the `wasm32-unknown-unknown` target, builds the parser with
  `wasm-pack`, runs the fixture suite, uploads the WASM artifact), and
  `deploy.yml` (applies D1 migrations, deploys with Wrangler using
  scoped `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets,
  smoke-tests production against the §1.6 performance budgets, and
  rolls back on failure). CI is now the only place Rust is compiled and
  the only origin of production deploys — no dashboard code edits.

### Changed

- **Web UI rebuilt for incremental sync.** The v1 UI's fixed 10-second
  `setInterval` poll and wholesale `innerHTML` rebuild are gone. The v2
  UI (`ui/index.html`, `ui/app.js`, `ui/styles.css`, assembled by
  `scripts/build-ui.mjs`) runs a long-poll sync loop on `/api/wait`
  (no timers; the loop aborts when the tab is hidden and restarts when
  visible), applies deltas as keyed DOM operations from a
  `Map<id, HTMLElement>` — prepending new rows in one
  `DocumentFragment`, removing deleted rows, leaving all other nodes
  untouched so scroll position and the open message survive a sync —
  and renders every mail-derived string with `textContent`, never
  `innerHTML`. First paint no longer blocks on a serial `/api/config`
  fetch, list rows show the OTP with a copy affordance, and full bodies
  are fetched on demand from `GET /api/mail/:id` into a small in-memory
  LRU instead of shipping with the list.
- **List payloads are preview-only, one shape everywhere.** List, delta,
  wait, and pagination responses return the single preview row shape
  (`id`, `sender`, `subject`, `preview`, `otp`, `created_at`, plus
  `address`) and never `text_body` / `html_body`. This is the one
  deliberate breaking change from v1, whose
  `GET /api/inboxes/:address/messages` selected and shipped full bodies
  for every row. Full bodies are fetched one message at a time from
  `GET /api/mail/:id`; `?full=1` on the inbox-messages endpoint is the
  explicit opt-in escape hatch for agent flows that need links from
  just-arrived mail.
- **D1 schema v2: stored `preview` / `otp` columns and a composite
  index.** The migration (`db/migrate-v1-to-v2.sql`, fresh-install form
  in `db/schema-v2.sql`) is additive and idempotent-ish: it adds
  nullable `preview TEXT` and `otp TEXT` columns to `mails` — computed
  once at ingest by whichever parser ran, instead of a per-row regex
  over full bodies and `substr(text_body,1,200)` on every read; pre-v2
  rows stay `NULL` and reads fall back via `COALESCE`, with no mass
  backfill — and creates `idx_mails_address_id ON mails(address, id DESC)`
  plus `idx_mails_created_id ON mails(created_at, id)` for the bounded
  cron expiry scan. Because the migration drops and renames nothing, the
  v1 Worker keeps working against the migrated schema and a Worker
  rollback stays safe. See the [Unreleased](#unreleased) note for the
  pending `INCLUDE` covering-index optimisation.
- **Read and write query shapes.** Auth + list collapse from two serial
  D1 queries (token → address, then address → mails) into one JOIN, so a
  list request costs one D1 round trip; ingest collapses from 2–3 serial
  statements into a single `DB.batch()` (ensure-address + insert-mail);
  the hourly cleanup deletes in bounded chunks
  (`DELETE … LIMIT 1000`, repeated) instead of two unbounded deletes.
- **`DELETE /api/mail/:id` now requires the Bearer token** for the
  owning inbox (`401` without one). The v1 baseline deleted with no auth
  check; clients that already send the header, as `AGENTS.md` has always
  instructed, see no change.
- **`POST /api/new_address` rejects a name that sanitises to empty**
  with `400 {"error":"Invalid name"}`. v1 silently produced a degenerate
  address.
- **Observability.** API responses gain `Server-Timing` and ingest logs
  record which parser ran (`parser: "wasm" | "js"`), so fallback usage
  and the performance budgets in `docs/ARCHITECTURE.md` §1.6 are
  measurable instead of asserted.

### Fixed

- **Mail visibility latency: ~10.6 s worst case → ≤ ~1 s typical.**
  In v1 the UI polled on a fixed 10 s timer and each poll re-downloaded
  the full list, so a verification code took up to ~10.6 s to appear
  (10 s waiting for the next tick + ~0.6 s for the list request;
  ~5.6 s on average). v2's long-poll returns as soon as mail lands:
  the server's internal indexed check runs about every 750 ms, so
  mail-to-visible is ingest time + ≤ ~1 s in an open UI, with a worst
  case of one 25–30 s wait cycle plus a retry. The Node client gets the
  same profile via `waitForMail()` / `watch()`.
- **Slow list endpoints.** `GET /api/inboxes/:address/messages`
  measured 0.43–0.67 s in v1 because it shipped full bodies, ran the
  OTP regex per row per read, sorted without a covering composite
  index, and paged with `OFFSET`. Preview-only payloads, stored
  `preview`/`otp`, the `(address, id)` index, cursor pagination, and
  ETag/`304` revalidation bring list and delta sync inside the v2
  budget of ≤ 0.15 s warm and ≤ 2 KB for a no-new-mail delta.
- **Slow health/config probes.** `/api/health` measured 0.25–0.55 s in
  v1 despite doing no work, because nothing was cacheable and every
  probe paid a full origin round trip on a frequently cold isolate.
  PoP caching and ETags for UI/health/config bring warm health inside
  the ≤ 0.05 s budget.
- **Offset pagination drift.** Pages fetched with `limit`/`offset`
  shifted when mail arrived mid-browse, duplicating or skipping rows.
  `before_id` cursor pages are pinned to a mail ID and cannot drift;
  `offset` is deprecated but still honoured for legacy clients.

### Security

- **UI XSS surface removed.** Mail subject, sender, and preview are
  attacker-controlled by definition. v1 built rows by interpolating
  them into `innerHTML` behind a manual `esc()` helper; v2 builds rows
  with `createElement` + `textContent`, so no mail-derived string ever
  reaches `innerHTML`.
- **Delete now authenticated.** See Changed: `DELETE /api/mail/:id`
  requires the owning inbox's Bearer token in v2 (`401` otherwise).
- **Parser memory safety on untrusted input.** Ingest parses raw,
  attacker-controlled MIME bytes. The new Rust parser performs that
  parsing in memory-safe Rust (with the tested JS parser as fallback),
  instead of relying solely on ad-hoc regex/`split()` code.
- **Deploy credentials stay scoped and short-lived.** Production
  deploys originate only from GitHub Actions using
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from repository
  secrets, scoped to Workers Scripts Edit, D1 Edit, Workers Routes
  Edit, Email Routing Rules Edit, and Zone Read for this account/zone.
  No token is stored in the repository; `wrangler.toml` contains only
  non-secret values. This continues the v1 pattern of creating a scoped
  token, deploying, verifying, and deleting it (see [1.0.0]).
- **Secrets etiquette is contractual.** Per-inbox tokens, OTPs, and
  verification links are secrets: tokens are 64-char hex from 32
  cryptographically random bytes (the `jwt` field remains a legacy
  alias for the same value, not a signed JWT), the `Authorization`
  header is preferred over the `?token=` fallback that leaks into logs
  and history, and `AGENTS.md` §6 makes one-wait-per-inbox, back-off on
  `429`/`Retry-After`, and never logging secrets mandatory for clients.
- **Known limit, unchanged and documented:** address-as-capability.
  Anyone who knows an address can read its mail via
  `GET /api/inboxes/:address/messages`, and in v1 anyone who knew a
  mail ID could read it via `GET /api/mail/:id`. Temp mail remains for
  disposable, low-sensitivity mail (sign-up confirmations, throwaway
  OTPs) — use random local parts, and never route mail you could not
  tolerate a stranger reading if they guessed the address.

## [1.0.0] - 2026-11-21

The first live release: a self-hosted disposable email service on
`turjaun.xyz`, running entirely on Cloudflare's free tier with no mail
server, no VPS, and nothing listening on port 25.

### Added

- **Cloudflare Worker + D1 + catch-all, live.** Cloudflare Email
  Routing (MX `route1/2/3.mx.cloudflare.net`, SPF
  `v=spf1 include:_spf.mx.cloudflare.net ~all`) receives mail for any
  address on `turjaun.xyz` via a catch-all rule — **Send to a Worker:
  `temp-mail`, enabled** — and hands it to the Worker at
  https://temp-mail.turjaun.workers.dev. The D1 database `temp-mail-db`
  stores `addresses` and `mails` (schema v1: `idx_mails_address`,
  `idx_mails_created`, `idx_addresses_token`, `idx_addresses_address`);
  an hourly cron (`0 * * * *`) deletes addresses and mail older than
  the 24-hour TTL (`MAIL_TTL_HOURS=24`, `DOMAINS=turjaun.xyz`, D1 bound
  as `DB`). The pre-existing specific rule
  `me@turjaun.xyz → myeasin985@gmail.com` was left untouched.
- **REST API (v1 contract).** `GET /api/health`, `GET /api/config` and
  its alias `GET /api/domains`, `POST /api/new_address` (create or
  re-claim an inbox, returning `address` + per-inbox `token` with the
  `jwt` legacy alias), `GET /api/mails` (Bearer-authenticated preview
  list, `limit` default 20 / max 50, `offset` pagination),
  `GET /api/inboxes/:address/messages` (full messages for an address,
  with `otp`), `GET /api/mail/:id` (one full message with `otp`), and
  `DELETE /api/mail/:id`. OTP extraction returns the first 4–8 digit
  code found in body + subject.
- **Web UI.** A zero-dependency, single-file Worker-served page to
  create or randomise an inbox, save its token in `localStorage`,
  refresh the inbox, and read a message with its OTP — no build step,
  no framework.
- **Zero-dependency single-file Worker.** The v1 Worker
  (`worker-single-file.js`, preserved in v2 as
  `src/worker-v1-baseline.js`) implements fetch, email, and scheduled
  handlers, including a hand-rolled JavaScript MIME parser (multipart
  splitting, base64 / quoted-printable decoding, HTML stripping) with a
  placeholder-row fallback insert so a parse failure never silently
  loses a mail. Bodies are capped at 50,000 chars as stored.
- **Direct Workers-API deploy script** (`scripts/deploy-api.py`):
  uploads the Worker script via
  `PUT /accounts/<account-id>/workers/scripts/temp-mail` with its D1
  binding and variables as multipart metadata and sets the cron
  schedule — the deploy method that actually shipped v1 (see Fixed).

### Fixed

- **Hello World deploy incident, and the API deploy fix.** The Worker
  was created in the Cloudflare dashboard with variables, D1 binding,
  and cron correctly configured, but it initially went live running
  Cloudflare's default "Hello World!" code: the dashboard (Monaco) code
  editor in the controlling browser could not receive a paste of the
  ~9,600-character Worker file, and typing it would have corrupted it
  via auto-closing brackets, so the editor was deliberately left clean.
  Symptoms: every route, including `/api/health` and
  `POST /api/new_address`, returned `Hello World!`, and the Email
  Routing catch-all could not be pointed at the Worker at all —
  Cloudflare only lists Workers whose deployed code exports an `email`
  handler, and Hello World has none, so the catch-all stayed
  Drop / Disabled. Fix: a temporary, scoped dashboard API token
  (`temp-mail-deploy-temp` — Workers Scripts Edit, D1 Edit, Workers
  Tail Read, Account Settings Read on the account; Workers Routes Edit,
  Email Routing Rules Edit, Zone Read on `turjaun.xyz`) was created,
  the real code was deployed directly via the Workers API (deploy
  response confirmed handlers `fetch`, `email`, `scheduled`), the
  catch-all was then set via the Email Routing API to
  worker `["temp-mail"]` with `enabled: true` and verified by reading
  it back, and the temporary token was deleted in the dashboard
  immediately after verification, with the token list confirmed back
  to its previous count. Verified live after the fix:
  `GET /api/health` returned `{"ok":true,"service":"temp-mail","domain":["turjaun.xyz"]}`,
  inbox creation returned a real `test123@turjaun.xyz` address and
  token, the UI served the Temp Mail page instead of Hello World, and
  the user confirmed end-to-end mail delivery working.

### Security

- **Temporary deploy token handling.** The one-off deploy token above
  was scoped to the minimum permissions for that deployment, used once,
  and deleted in the dashboard as soon as the deploy was verified. No
  deploy credential was committed to any repository or stored in
  project files; this pattern (create scoped → deploy → verify →
  delete) is the documented manual-deploy procedure carried into v2's
  CI secrets model.

[Unreleased]: https://github.com/turjaun985123/temp-mail-turjaun/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/turjaun985123/temp-mail-turjaun/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/turjaun985123/temp-mail-turjaun/releases/tag/v1.0.0
