# Temp Mail — turjaun.xyz

[![CI](https://github.com/turjaun985123/temp-mail-turjaun/actions/workflows/ci.yml/badge.svg)](https://github.com/turjaun985123/temp-mail-turjaun/actions/workflows/ci.yml)
[![Deploy](https://github.com/turjaun985123/temp-mail-turjaun/actions/workflows/deploy.yml/badge.svg)](https://github.com/turjaun985123/temp-mail-turjaun/actions/workflows/deploy.yml)
[![Build WASM](https://github.com/turjaun985123/temp-mail-turjaun/actions/workflows/build-wasm.yml/badge.svg)](https://github.com/turjaun985123/temp-mail-turjaun/actions/workflows/build-wasm.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Runtime: Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-orange)
![Database: D1](https://img.shields.io/badge/database-D1%20(SQLite)-blue)

> Disposable email on your own domain — create an inbox in one API call,
> receive mail instantly, read the OTP from a structured field, and let
> everything auto-delete after 24 hours. No mail server, no VPS, no SMTP
> daemon to maintain.

**Live demo:** https://temp-mail.turjaun.workers.dev
**Domain:** `turjaun.xyz` · **Repository:** `turjaun985123/temp-mail-turjaun`

---

## What it is

Temp Mail is a self-hosted temporary / disposable email service that runs
entirely on Cloudflare's free tier:

- **Cloudflare Email Routing** receives mail for *any* address on
  `turjaun.xyz` (catch-all) and hands it to a Worker — nothing ever
  listens on port 25.
- A **Cloudflare Worker** is both the inbox API and the web UI.
- **Cloudflare D1** (SQLite) stores addresses and mail for 24 hours; an
  hourly cron deletes everything older than that.
- A **Rust → WebAssembly MIME parser** handles incoming mail on the ingest
  path in v2, with the original JavaScript parser kept as a tested fallback.
- A zero-dependency **Node.js client** (`packages/node-client`) and a
  dedicated **[`AGENTS.md`](AGENTS.md)** make the service usable by scripts
  and AI agents, not just humans in a browser.

It was built to fix the one thing that made v1 feel slow: the UI polled the
inbox every 10 seconds and re-downloaded the full message bodies every
time, so a verification code could take ~10.6 s to appear. v2 replaces
polling with a long-poll endpoint, preview-only payloads, cursor sync, and
HTTP caching — see [Features](#features) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full diagnosis and
performance budgets.

---

## Features

### v1 — the live foundation

- **Catch-all inboxes** — any `<name>@turjaun.xyz` receives mail, even if
  the address was never created in advance.
- **One-call inbox creation** — `POST /api/new_address` returns an address
  plus a per-inbox bearer token; omit `name` for a random address, or
  re-claim an existing name and get its token back (`"reused": true`).
- **Full REST API** — create, list, read, and delete mail as JSON
  (see [`docs/API.md`](docs/API.md)).
- **OTP extraction** — every full message carries an `otp` field with the
  first 4–8 digit code found, so clients don't have to regex bodies.
- **Web UI** — create an inbox, watch it, and read mail in the browser;
  no build step, no framework.
- **24-hour TTL** — addresses and mail are deleted automatically by an
  hourly scheduled cleanup.
- **Free-tier friendly** — Workers + D1 + Email Routing, no server costs.

### v2 — speed and usefulness

- **Long-poll `GET /api/wait`** — one request holds open (default 25 s,
  max 30 s) and returns the moment new mail arrives. One wait replaces
  dozens of polls; typical mail-to-visible time drops from ~10.6 s to
  ≤ ~1 s.
- **Incremental sync** — `since_id` / `before_id` cursor pagination and a
  `next_since_id` cursor on list/wait responses. An up-to-date client
  syncs in tens of bytes instead of re-downloading the whole inbox, and
  cursor pages don't drift when new mail arrives mid-browse.
- **Preview-only list payloads** — lists return one small preview row
  shape (`id`, `sender`, `subject`, `preview`, `otp`, `created_at`)
  everywhere; full bodies are fetched one at a time from
  `GET /api/mail/:id`, on demand.
- **OTP and preview computed once, at ingest** — stored as columns, not
  re-derived with a regex over full bodies on every read.
- **Rust WASM MIME parser** — correct handling of nested multipart,
  RFC 2047 encoded-word headers, charsets, and base64 / quoted-printable
  bodies, parsing attacker-controlled bytes in memory-safe Rust. Used
  *only* on the ingest path (the fetch path pays zero WASM cost), with
  the v1 JS parser as a mandatory, tested fallback.
- **Faster D1 access** — a composite `(address, id)` index makes list,
  delta, and wait queries index-only; auth + list collapse from two
  serial queries into one JOIN; ingest is a single `DB.batch()`.
- **HTTP caching & ETags** — PoP-cached UI/health/config, `ETag` / `304`
  revalidation for lists, and immutable caching for individual messages.
- **Incremental, safe UI** — long-poll sync loop (no timers, pauses in
  hidden tabs), keyed DOM updates instead of full `innerHTML` rebuilds,
  and all mail-derived text rendered via `textContent`.
- **Node.js client SDK** — `@turjaun/temp-mail-client`
  (`packages/node-client`): zero dependencies, Node 18+, with
  `createInbox()`, `waitForMail()` / `waitForOTP()`, and a `watch()` loop
  implementing the same sync algorithm as the UI.
- **Agent-ready** — [`AGENTS.md`](AGENTS.md) documents the exact workflow
  an AI agent must follow to get an OTP: create → submit → `/api/wait` →
  read `otp` → clean up, with mandatory anti-polling etiquette.
- **CI-only deploys** — GitHub Actions builds the Rust parser, runs tests,
  applies D1 migrations, deploys with Wrangler, smoke-tests production,
  and rolls back on failure. No dashboard code edits, no local `rustc`.

---

## Architecture

```text
                            ┌─────────────────────────────────────────────┐
                            │              Cloudflare edge                │
                            │                                             │
  Sender                    │   ┌──────────────┐    ┌─────────────────┐   │
    │                       │   │ Email        │    │  Worker         │   │
    │  SMTP                 │   │ Routing      │    │  temp-mail      │   │
    └───────────────────────┼──►│ (catch-all)  ├───►│                 │   │
                            │   │ MX: route*.  │    │  fetch() ───────┼───┼──► Web UI (/)
                            │   │ mx.cloud-    │    │  email()        │   │    REST API (/api/*)
                            │   │ flare.net    │    │  scheduled()    │   │
                            │   └──────────────┘    │    │            │   │         ▲
                            │                       │    │ ingest     │   │         │
                            │   ┌──────────────┐    │    ▼            │   │         │
                            │   │ D1 (SQLite)  │◄───┤  Rust WASM      │   │   ┌─────┴────────┐
                            │   │ temp-mail-db │    │  MIME parser    │   │   │ Clients      │
                            │   │              │    │  (JS fallback)  │   │   │              │
                            │   │ addresses    │    └─────────────────┘   │   │ Browser UI   │
                            │   │ mails        │                          │   │ curl / scripts│
                            │   │ (24 h TTL,   │    ┌─────────────────┐   │   │ Node client  │
                            │   │ hourly cron  │    │  Cron trigger   │   │   │ AI agents    │
                            │   │ cleanup)     │    │  0 * * * *      │   │   │ (AGENTS.md)  │
                            │   └──────────────┘    └─────────────────┘   │   └──────────────┘
                            └─────────────────────────────────────────────┘

  Flow:  mail to anything@turjaun.xyz
           → Email Routing catch-all → Worker email() handler
           → Rust WASM parser extracts subject / text / html / OTP
           → one D1 batch insert
           → waiting clients return immediately via GET /api/wait
```

Design contract, performance budgets, and the v1 → v2 change table live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The complete endpoint
contract lives in [`docs/API.md`](docs/API.md).

---

## Quick start — for users (web UI)

1. Open **https://temp-mail.turjaun.workers.dev**
2. Click **Random** for a random address (e.g. `a1b2c3d4e5@turjaun.xyz`),
   or type a custom name and click **Create**.
3. **Save the token** shown under the address — it's the key to that
   inbox in the API.
4. Use the address wherever an email is required. Incoming mail appears
   in the inbox automatically (v2 long-poll — no manual refreshing).
   Click a message to read it; the OTP, if any, is shown in the list.
5. Done. The address and its mail delete themselves after 24 hours.

> **Real-mail test:** create `test123@turjaun.xyz`, send it a message from
> Gmail with subject `Hello 123456`, and watch it arrive with
> `"otp": "123456"` extracted.

---

## Quick start — for developers (API)

Base URL: `https://temp-mail.turjaun.workers.dev`

```bash
BASE="https://temp-mail.turjaun.workers.dev"
```

### Check the service is up

```bash
curl -s "$BASE/api/health"
# {"ok":true,"service":"temp-mail","domain":["turjaun.xyz"],"time":"..."}

curl -s "$BASE/api/config"
# {"domains":["turjaun.xyz"],"ttl_hours":24}
```

### Create an inbox

```bash
# Random address
curl -s -X POST "$BASE/api/new_address" \
  -H "Content-Type: application/json" \
  -d '{"domain":"turjaun.xyz"}'

# Chosen name
curl -s -X POST "$BASE/api/new_address" \
  -H "Content-Type: application/json" \
  -d '{"name":"test123","domain":"turjaun.xyz"}'
# {"address":"test123@turjaun.xyz","token":"<token>","jwt":"<token>","expires_at":...}
```

Save both values:

```bash
ADDRESS="test123@turjaun.xyz"
TOKEN="<token from the response>"   # never commit or log this
```

### Wait for mail — long-poll, don't poll (v2)

```bash
# Holds open until new mail arrives or the wait times out (default 25 s).
# One call = one wait cycle. Never loop GET /api/mails on a timer instead.
curl -s "$BASE/api/wait" \
  -H "Authorization: Bearer $TOKEN"
```

### List and read mail

```bash
# Summaries for your inbox (newest first)
curl -s "$BASE/api/mails?limit=20&offset=0" \
  -H "Authorization: Bearer $TOKEN"

# Only mail newer than id 42 (cursor sync, v2)
curl -s "$BASE/api/mails?since_id=42" \
  -H "Authorization: Bearer $TOKEN"

# Full messages for an address, with otp on each result
curl -s "$BASE/api/inboxes/$ADDRESS/messages?limit=20" \
  -H "Authorization: Bearer $TOKEN"

# One full message — read .otp first, then .text_body / .html_body for links
curl -s "$BASE/api/mail/42" \
  -H "Authorization: Bearer $TOKEN"

# Delete a message you've consumed
curl -s -X DELETE "$BASE/api/mail/42" \
  -H "Authorization: Bearer $TOKEN"
# {"ok":true}
```

### Node.js client

```js
import { TempMailClient } from '@turjaun/temp-mail-client';

const client = new TempMailClient(); // defaults to the live base URL
const { address, token } = await client.createInbox();
console.log('Send mail to', address);
const otp = await client.waitForOTP(address, 60_000);
console.log('OTP:', otp);
```

See `packages/node-client/` for the full client API. Full endpoint
reference, error table, pagination/caching rules, and an OpenAPI-style
spec: [`docs/API.md`](docs/API.md).

---

## For AI agents

If you are an AI agent or automation that needs a disposable inbox for a
signup, a test, or an OTP: **read [`AGENTS.md`](AGENTS.md) and follow it
exactly.** Do not guess endpoints or invent parameters.

The short version:

1. `POST /api/new_address` → save `address` + `token` immediately.
2. Give `address` to the service and submit its form.
3. Call `GET /api/wait` **once per wait cycle** — never poll
   `GET /api/mails` on a timer, never run parallel waits.
4. Read the code from the message's **`otp` field** (fall back to body
   text only if `otp` is absent); handle verification links from
   `text_body` / `html_body` the same way.
5. Delete consumed messages; let the inbox expire on its 24 h TTL.
   Tokens, OTPs, and verification links are secrets — never log them.

---

## Self-host / deploy your own

You need: a domain, a free Cloudflare account, and Node.js 18+.
Your domain's nameservers must point to Cloudflare.

### 1. Create the D1 database

```bash
npx wrangler login
npx wrangler d1 create temp-mail-db
# Copy the printed database_id into wrangler.toml ([[d1_databases]])

npx wrangler d1 execute temp-mail-db --remote --file=db-schema-v1.sql
# For v2, also apply the v2 migration (indexes + preview/otp columns):
npx wrangler d1 execute temp-mail-db --remote --file=db/migrate-v1-to-v2.sql
```

Set your domain(s) and retention in `wrangler.toml`:

```toml
[vars]
DOMAINS = "yourdomain.com"        # comma-separate for multiple domains
MAIL_TTL_HOURS = "24"
```

### 2a. Deploy with Wrangler (standard method)

```bash
npm install
npx wrangler deploy
```

This deploys the Worker, its D1 binding, variables, and the hourly cron
trigger (`0 * * * *`) from `wrangler.toml`. In this repository, production
deploys normally originate from GitHub Actions (see
[CI](#testing)), which runs the same Wrangler deploy with
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` stored as GitHub secrets
— never commit a token to the repo.

### 2b. Deploy with the API script (no Wrangler, no dashboard editor)

The Cloudflare dashboard code editor cannot reliably receive large
pastes, so this repo also ships a direct-to-API deploy script — the
method used to ship v1:

```bash
export CLOUDFLARE_API_TOKEN="<scoped token>"   # see Security notes
export CLOUDFLARE_ACCOUNT_ID="<your account id>"
python3 scripts/deploy-api.py
```

The script uploads the Worker script via the Workers API
(`PUT /accounts/<id>/workers/scripts/temp-mail`) with its D1 binding and
variables as multipart metadata, sets the cron schedule, and prints the
result. It should report handlers `fetch`, `email`, and `scheduled` —
the `email` handler is what makes the Worker selectable in Email Routing.

### 3. Enable Email Routing + catch-all (required)

1. Cloudflare Dashboard → your domain → **Email → Email Routing** →
   enable it and let Cloudflare add the MX/TXT records
   (`route1/2/3.mx.cloudflare.net`, SPF). Verifying one real destination
   address (e.g. your Gmail) may be required to activate routing — existing
   specific-address rules are unaffected by the catch-all.
2. **Routing Rules → Catch-all address → Edit:**
   Action = **Send to a Worker**, select **`temp-mail`**, Save, and turn
   the catch-all **Active / ON**.
   (If `temp-mail` doesn't appear, its deployed code doesn't export an
   `email` handler yet — redeploy first.)
3. Verify:

```bash
curl -s https://temp-mail.<your-subdomain>.workers.dev/api/health
# {"ok":true,"service":"temp-mail","domain":["yourdomain.com"],...}
```

Then send a test mail to any address on your domain and read it back via
`GET /api/inboxes/<address>/messages`.

### Multiple domains

Add every domain to `DOMAINS`, redeploy, and repeat step 3 (catch-all →
same Worker) for each domain.

---

## Rust parser — building

The MIME parser is a Rust crate at `rust/mail-parser/`, compiled to
WebAssembly. **Rust is built in CI only** — there is no local `rustc` in
the development environment, and no local workflow may require one.

- **CI (the supported path):** the `build-wasm` GitHub Actions workflow
  installs the stable Rust toolchain with the `wasm32-unknown-unknown`
  target, builds with `wasm-pack`, runs the shared fixture corpus
  (native `cargo test`, WASM under Node, and the JS fallback under Node),
  and uploads the parser as a build artifact. The deploy workflow
  downloads that artifact; if it's missing, the deploy fails rather than
  silently shipping fallback-only ingest (unless explicitly overridden).
- **Manual equivalent** (on a machine with Rust installed):

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack   # or use a prebuilt wasm-pack release
wasm-pack build rust/mail-parser --target bundler --release
```

- **Budgets:** the `.wasm` must stay ≤ 150 KB gzipped (CI fails the build
  above that); release profile uses size optimisation + LTO.
- **Local development without Rust** is fully supported: `wrangler dev`
  and the JS tests run against the JS fallback parser by default. To dev
  against WASM, download the `.wasm` artifact from the latest green CI
  run — never compile locally as a prerequisite.
- The same crate is packaged for Node consumption, so the Worker and the
  Node side extract subject/text/OTP identically — one parser, one
  fixture suite, two hosts.

---

## Project structure

```text
temp-mail-turjaun/
├── README.md                  # This file
├── AGENTS.md                  # Mandatory instructions for AI agents using the API
├── wrangler.toml              # Worker config: bindings, vars, cron (no secrets)
├── db-schema-v1.sql           # D1 schema: addresses + mails tables, base indexes
├── db/
│   ├── schema-v2.sql          # v2 full schema (fresh installs)
│   └── migrate-v1-to-v2.sql   # v1→v2 migration: (address,id) index, preview/otp columns
├── src/
│   ├── worker-v1-baseline.js  # Deployed v1 Worker (single file, zero deps) — source of truth for v1 shapes
│   ├── worker-v2.js           # v2 Worker core: /api/wait, cursor sync, ETags
│   └── worker-final.js        # DEPLOYED v2: worker-v2 + inlined rate-limit/webhooks + built UI
├── ui/
│   ├── index.html             # Web UI shell (served by the Worker)
│   ├── app.js                 # Long-poll sync loop, keyed incremental DOM rendering
│   └── styles.css             # UI styles
├── rust/
│   └── mail-parser/           # Rust MIME parser crate
│       ├── Cargo.toml         #   cdylib + rlib; wasm-bindgen, serde
│       └── src/lib.rs         #   parseMime(bytes) -> { subject, from, text, html, otp, rawSize }
├── packages/
│   └── node-client/           # @turjaun/temp-mail-client — zero-dep Node 18+ ESM SDK
│       ├── package.json
│       └── index.js           #   TempMailClient: createInbox, waitForMail/OTP, watch, list/read/delete
├── scripts/
│   └── deploy-api.py          # Direct Workers-API deploy (no Wrangler / no dashboard paste)
├── tests/
│   └── api.test.mjs           # Integration tests (node:test, zero dependencies)
├── docs/
│   ├── API.md                 # Full API reference + OpenAPI-style spec
│   └── ARCHITECTURE.md        # v2 design contract, perf diagnosis & budgets
└── .github/
    └── workflows/
        ├── ci.yml             # PR checks: JS tests, fixtures, bundle & query-plan checks
        ├── build-wasm.yml     # Rust → WASM build + parser fixture suite (CI only)
        └── deploy.yml         # D1 migrations → wrangler deploy → smoke tests → rollback on failure
```

---

## Testing

### Integration tests

Zero-dependency, using only Node built-ins (`node:test`, `node:assert`,
global `fetch`). Each test creates its own random inbox, so the suite is
safe to run repeatedly and in parallel:

```bash
node --test tests/api.test.mjs

# Against a different deployment:
TEMP_MAIL_BASE=https://temp-mail.turjaun.workers.dev node --test tests/api.test.mjs
```

The `/api/wait` tests are v2-only: against a v1 server they mark
themselves skipped instead of failing. Node client syntax can be checked
with `npm run check` in `packages/node-client/`.

### Smoke & performance tests (CI)

Post-deploy smoke tests in the deploy workflow assert the v2 performance
contract from [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §1.6 / §7.4:

```text
GET  /api/health                  → 200 {"ok":true}, cache headers present
GET  /api/config                  → 200 + ETag; repeat with If-None-Match → 304
POST /api/new_address             → 200, address @turjaun.xyz + token
GET  /api/mails (Bearer)          → 200, empty list, next_since_id present
GET  /api/wait?since_id=0&timeout=0 → 200, timeout:true (empty inbox)
GET  /api/inboxes/<addr>/messages → 200, preview shape, NO full bodies by default
Timing: health & list p95 within budget over 20 warm samples
```

| Metric | v1 measured | v2 target (p95, warm) |
|---|---|---|
| `GET /api/health` | 0.25–0.55 s | ≤ 0.05 s |
| List endpoints | 0.43–0.67 s | ≤ 0.15 s, preview payload only |
| Delta sync (no new mail) | full refetch | ≤ 2 KB, ≤ 0.15 s |
| New mail → visible in open UI | up to ~10.6 s | ≤ ~1 s typical |
| D1 statements per list request | 2 | 1 |

Query plans are also asserted in CI (`EXPLAIN QUERY PLAN` must show the
`(address, id)` index with no temp B-tree sort), and the WASM bundle is
size-checked (≤ 150 KB gzipped). End-to-end real-mail delivery (send →
appears via `/api/wait`) is a manual/scheduled check after each production
deploy, not a PR gate — it depends on external senders and would make CI
flaky.

---

## Security notes

- **Per-inbox tokens.** Creating an inbox returns a 64-character hex
  bearer token (32 cryptographically random bytes; the `jwt` field is a
  legacy alias for the same value, not a signed JWT). One token maps to
  exactly one address. Store it at creation time — it's the only
  credential — and send it as `Authorization: Bearer <token>`. Prefer the
  header over the `?token=` fallback, which leaks into logs and history.
  Never commit tokens, print them in user-facing output, or share one
  inbox's token with another task.
- **Address-as-capability (know the limit).** In the v1 contract, anyone
  who knows an address can read its full mail via
  `GET /api/inboxes/:address/messages`, and anyone who knows a mail `id`
  can read it via `GET /api/mail/:id`. Use random local parts (the
  default) for anything even slightly sensitive, and treat temp mail as
  what it is: for disposable, low-sensitivity mail such as sign-up
  confirmations and throwaway OTPs — never for mail you couldn't tolerate
  a stranger reading if they guessed the address. HTML bodies are
  untrusted content; the v2 UI renders mail text with `textContent`,
  never `innerHTML`.
- **24-hour TTL.** Addresses, tokens, and mail are deleted after
  `MAIL_TTL_HOURS` (24 on the live service) by the hourly cron. There is
  no refresh or recovery — after expiry the token returns `401` and the
  mail is gone. Don't design flows that need mail after 24 hours.
- **Temporary deploy-token handling.** Deploy credentials are scoped,
  short-lived, and never stored in the repo:
  - CI uses `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from GitHub
    Actions secrets only, scoped to Workers Scripts Edit, D1 Edit,
    Workers Routes Edit, Email Routing Rules Edit, and Zone Read for
    this account/zone.
  - The v1 API deploy used a temporary custom token
    (`temp-mail-deploy-temp`, same scoped permissions) created in the
    dashboard for that one deployment — it was **deleted in the dashboard
    immediately after the deploy was verified**, and the token list was
    confirmed back to its previous state. Follow the same pattern for any
    manual deploy: create scoped → deploy → verify → delete.
  - Wrangler config in this repo contains only non-secret values (names,
    the D1 database *id*, public vars). If a token ever appears in a
    commit, log, or chat, treat it as compromised and revoke it.
- **Etiquette is a security control too.** Honour `429` / `Retry-After`,
  back off on errors, one outstanding `/api/wait` per inbox, and use the
  service only for signups and testing you're authorised to automate —
  not to evade bans or abuse controls. See `AGENTS.md` §6.

---

## License

MIT — see the `LICENSE` file / package metadata. Use it, fork it, and
point it at your own domain.

---

*Live service: https://temp-mail.turjaun.workers.dev · API reference:
[`docs/API.md`](docs/API.md) · Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
Agents: [`AGENTS.md`](AGENTS.md)*
