# Temp Mail v2 — Final Audit

**Auditor:** Agent 30 of 30 (Batch 3), final-audit seat.
**Snapshot:** 2026-11-21 12:43 UTC. The tree was still changing during the
audit (files listed in §1 notes marked † appeared mid-audit), so this is an
audit of the tree as it stood at the snapshot time, not of any later state.
**Method:** full file inventory (`find . -type f`), read/skims of the key
files named in the audit brief, `node --check` / `py_compile` on every code
file, a trial run of `scripts/build-ui.mjs` in a scratch copy, and the
cross-file consistency greps reported in §3. No file other than this one
was edited.
**Status key:** **verified** = I ran a check on it and it passed ·
**present** = exists and was read/skimmed, no executable check applies or
was possible here · **unverified** = exists, but its correctness depends on
something outside this tree (live D1, GitHub, a Rust toolchain) that this
audit could not exercise.

---

## Verdict (summary — full reasoning in §4)

## READY WITH GAPS

The v2 code that exists is real, syntactically valid, and internally
largely consistent — but **nothing in this tree is wired together into the
release the README describes.** The deploy entry point
(`wrangler.toml: main = "src/worker-v2.js"`, and `scripts/deploy-api.py`)
ships the *un-integrated* worker: no new UI, no rate limiting, no webhooks,
no WASM parser, and no use of the v2 schema columns. Every headline v2
feature exists somewhere in the tree; almost none of them are on the path
that actually deploys. The gaps in §2 are integrator work, not rewrites —
but until at least gaps G1–G5 are closed, deploying from this tree
releases "v1 + `/api/wait` + cursor pagination + ETags", not v2 as
documented.

---

## 1. Inventory — every file, purpose, status

### 1.1 Root & config

| File | Purpose | Status |
|---|---|---|
| `wrangler.toml` (1,681 B) | Worker config: name `temp-mail`, `main = "src/worker-v2.js"`, `DOMAINS="turjaun.xyz"`, `MAIL_TTL_HOURS="24"`, D1 binding `DB` → `temp-mail-db` / `324a85a1-e2a8-417e-883b-4b23e060fbce`, hourly cron `0 * * * *`. Secrets correctly kept out (comments direct to `wrangler secret put`). | verified (values cross-checked in §3) |
| `package.json` (661 B) | `temp-mail-turjaun` v2.0.0; scripts: `check`, `db:init` (applies `db/schema-v2.sql`), `deploy`, `dev`, `test` (only `tests/api.test.mjs`), `perf`. | verified (JSON parses; script targets exist) |
| `.gitignore` (345 B) | Ignores `node_modules/`, `.wrangler/`, `.dev.vars`, `.env*`, Rust `target/`, wasm `pkg/`. Does **not** ignore `__pycache__/` (see §2 G10) or the build output `src/worker-v2.built.js`. | present |
| `AGENTS.md` (16,685 B) | Agent instructions: base URL, create → wait → read-`otp` workflow, endpoint table, error table, anti-polling etiquette. Matches `worker-v2.js` behaviour for the 8 endpoints it documents (see mismatch M5 in §3). | present |
| `README.md` (25,021 B) | Public readme: features, architecture, quickstart, project structure. Several claims exceed the wired reality — see M3, M4, M6 in §3. Badges point at `turjaun985123/temp-mail-turjaun`. | present (claims partially contradicted) |
| *(missing)* `LICENSE` | README carries an MIT badge and "MIT — see the `LICENSE` file" (README ~line 536), but **no LICENSE file exists in the tree**. | **gap — absent** |
| *(missing)* `.git/` | **Not a git repository.** No `.git`, no remote. The GitHub repo the README/badges reference does not yet contain this tree (nothing has been committed or pushed from here). | **gap — absent** |

### 1.2 Worker source (`src/`)

| File | Purpose | Status |
|---|---|---|
| `src/worker-v2.js` (19,864 B) | The deploy entry point. Single-file, zero-import ESM worker: all v1 endpoints + `GET /api/wait` (25 s long-poll, 1.2 s D1 poll), cursor pagination (`since_id`/`before_id`, `next_before_id`, `latest_id`), ETag/304 list responses (`listJson`, FNV-1a), keyword-aware `extractOTP`, `extractLinks`/`extractVerificationLinks`, JS `parseRaw` MIME parser, hourly cleanup. Exports `parseRaw`, `extractOTP`, `extractLinks`, `extractVerificationLinks`, `UI_HTML` (used by the CI smoke test). | verified (`node --check` passes; exports match CI smoke imports) |
| `src/worker-v2-integrated.js` † (35,149 B) | Appeared mid-audit. `worker-v2.js` with `rate-limit.js` and `webhooks.js` **inlined** (rate limiters on inbox-create/read/wait; HMAC webhook delivery on ingest; extra vars `WEBHOOK_URL`/`WEBHOOK_SECRET`). Header says it exists because the live deploy is a single-file API upload. **Nothing references it** — see G1. | verified (syntax passes; duplication confirmed by grep/diff, §2 G1) |
| `src/worker-v1-baseline.js` (10,833 B) | Frozen copy of the deployed v1 worker; stated source of truth for v1 shapes in `docs/API.md`/`docs/ARCHITECTURE.md`. Identical in size and behaviour to the v1 single-file worker built earlier in this project. | verified (syntax passes) |
| `src/rate-limit.js` (12,770 B) | Standalone rate-limiter module (`createRateLimiter`, `getClientKey`, `rateLimitResponse`, `RECOMMENDED_LIMITS`). Exported, documented — and **imported by nothing** except its inlined copy inside `worker-v2-integrated.js`. | verified (syntax passes; orphan confirmed by grep) |
| `src/sse.js` (13,467 B) | SSE alternative to `/api/wait` (`createSSEStream`, `/api/stream` proposal). Its own header honestly recommends `/api/wait` as the default and states SSE is **not** part of the v1/v2 API. Imported by nothing; no route exists for it in either worker file. | verified (syntax passes; deliberately unintegrated) |
| `src/webhooks.js` (7,318 B) | Webhook module (`validateWebhookUrl`, `signPayload` HMAC, `deliverWebhook`). Imported by nothing; inlined copy lives in `worker-v2-integrated.js` only. | verified (syntax passes; orphan except via G1 copy) |
| *(missing)* `src/worker-v2.built.js` | Output of `scripts/build-ui.mjs` (worker + real UI from `ui/*`). **Not generated in this tree.** I generated it in a scratch copy: build succeeds, output 60,334 B, syntax-valid, claimed deterministic. But no deploy path consumes it — see G2. | **gap — not generated, not referenced** |

### 1.3 Web UI (`ui/`)

| File | Purpose | Status |
|---|---|---|
| `ui/index.html` (9,716 B) | New v2 UI shell. | present |
| `ui/styles.css` (14,311 B) | New v2 UI styles. | present |
| `ui/app.js` (18,417 B) | New v2 UI logic: `/api/wait?since_id=` long-poll loop with `AbortController`, 3 s `/api/mails` fallback, keyed updates. Syntax-valid. **Served by nothing**: both worker files still embed the shortened v1 placeholder `UI_HTML` (the worker-v2.js comment at the UI block says so explicitly: "UI placeholder: Agent 3/4's UI replaces UI_HTML during integration"). The user's headline complaint — "message showing not so fast / UI not perfect" — is therefore **not fixed on any deploy path in this tree**, even though the fix itself exists here. | verified (syntax) / **not integrated (G2)** |

### 1.4 Database (`db/`, root)

| File | Purpose | Status |
|---|---|---|
| `db/schema-v2.sql` (8,042 B) | Fresh-install v2 schema: v1 tables unchanged + `mails.preview`, `mails.otp` (nullable), composite indexes `idx_mails_address_id (address, id DESC)` and `idx_mails_created_id (created_at, id)`, v1 address indexes kept. Header honestly documents why the covering-index `INCLUDE` form is not used (local SQLite builds reject it). | present (read in full; internally consistent with ARCHITECTURE §6) |
| `db/migrate-v1-to-v2.sql` (9,402 B) | In-place v1→v2 migration: additive `ALTER TABLE … ADD COLUMN preview/otp` + new indexes; header honestly flags it is only "idempotent-ish" (re-running fails on the first ALTER, harmlessly). This is the file the **live** database needs. | present |
| `db-schema-v1.sql` (759 B) | Deployed v1 schema (root, as in v1 repo layout). Kept as baseline/rollback reference. | present |
| — live D1 state | Live `temp-mail-db` (`324a85a1-…`) was created with the **v1** schema during the v1 deploy. **No evidence in this tree that `migrate-v1-to-v2.sql` (or `schema-v2.sql`) has been run against it**, and this audit had no Cloudflare credentials to check. Treat as **not applied** until the integrator runs it and verifies `PRAGMA table_info(mails)` shows `preview`/`otp`. Note the failure mode is benign: `worker-v2.js` never selects or inserts those columns (§2 G4), so v2 code runs against a v1 database — and a migrated database runs v1 code. | **unverified / presumed not applied (G5)** |

### 1.5 Rust parser (`rust/mail-parser/`)

| File | Purpose | Status |
|---|---|---|
| `rust/mail-parser/src/lib.rs` (24,097 B) | Pure-Rust MIME core (`parse_email_impl`, `extract_otp_impl`, `extract_links_impl`) + `#[wasm_bindgen]` exports (`parse_email` → JSON string, `extract_otp`, `extract_links`, `extract_links_json`). Hand-rolled base64/QP decoders, RFC 2047 header decoding, recursive multipart, 50,000-char caps matching v1, inline `#[cfg(test)]` suite (OTP/link cases). | present (read/skimmed; **cannot be compiled or tested in this environment — no rustc, by project rule CI is the only Rust build**) |
| `rust/mail-parser/Cargo.toml` (430 B) | `mail-parser` 0.1.0, `crate-type = ["cdylib","rlib"]`, deps `wasm-bindgen 0.2`, `serde`, `serde_json`; release `opt-level 3, lto`. | present |
| *(missing)* `Cargo.lock` | Not in tree. `build-wasm.yml`'s cache key hashes it (`hashFiles('…Cargo.toml', '…Cargo.lock')`) — a missing file just weakens the cache key, not a build failure, but the lockfile should be generated and committed for reproducible WASM builds. | **gap — absent** |
| *(missing)* `pkg/` (WASM output) | No `.wasm` anywhere in the tree (git-ignored by design; produced only by `build-wasm.yml`). Nothing to wire locally — see G3. | **gap — CI-only artefact** |
| Shape note | `ParsedEmail` is `{subject, from, text, html}` — it does **not** return `preview` or `otp` fields. README's structure section claims `parseMime(bytes) -> { subject, from, text, html, otp, rawSize }`; no function named `parseMime` exists in the crate (the export is `parse_email`), and `otp` is a separate export (`extract_otp`), not part of the parse result. See M6. | mismatch (§3) |

### 1.6 Client, examples, scripts

| File | Purpose | Status |
|---|---|---|
| `packages/node-client/index.js` (30,621 B) + `package.json` (614 B) | `@turjaun/temp-mail-client`, zero-dep Node ≥18 ESM SDK. Covers `/api/health`, `/api/config`, `/api/new_address`, `/api/mails`, `/api/inboxes/:address/messages`, `/api/mail/:id`, `/api/wait` (grep-verified endpoint set matches the worker). | verified (syntax passes; endpoints cross-checked) |
| `examples/node-signup-otp.mjs` † (4,644 B) | Worked signup-OTP example against the client. | verified (syntax passes) |
| `examples/curl-examples.sh` † | curl examples. Appeared in the final snapshot; not individually audited beyond inventory. | present (unaudited content) |
| `scripts/build-ui.mjs` (16,175 B) | Builds `src/worker-v2.built.js` by replacing the `UI_HTML` export in `worker-v2.js` with HTML generated from `ui/*`. | verified — **ran it in a scratch copy**: inputs read correctly, generated HTML 42,519 B, output 60,334 B, output passes `node --check`. Determinism claim not re-run-verified a second time. |
| `scripts/deploy-api.py` (10,208 B) | Direct Workers-API deploy (the proven v1 method): multipart PUT of **`src/worker-v2.js`** (hard-coded `WORKER_PATH`), D1 binding id and default account id `079c053e14d1aa42628ca4b62f2b492a` hard-coded consistently with `wrangler.toml`, schedule PUT, health check. Token taken from env, not committed — good. | verified (`py_compile` passes; constants cross-checked §3) |
| `scripts/d1-maintenance.py` † (13,697 B) | D1 maintenance utility (appeared mid-audit). | verified (`py_compile` passes; behaviour unaudited) |
| `scripts/__pycache__/deploy-api.cpython-312.pyc`, `…/d1-maintenance.cpython-312.pyc` | Interpreter bytecode from running the scripts here. Junk for a repo: `__pycache__/` is **not** in `.gitignore`. Must not be committed. | **gap — delete + gitignore (G10)** |

### 1.7 Tests

| File | Purpose | Status |
|---|---|---|
| `tests/api.test.mjs` (8,007 B) | Live integration tests (`node:test`) against `TEMP_MAIL_BASE` (default production). Wired as `npm test`. By design **not** run in CI (they hit production). Not run by this audit (would create real inboxes against the live service). | verified (syntax passes) / not executed |
| `tests/ui.test.mjs` † (7,057 B) | UI static QA suite. **Not referenced by `package.json` scripts or any workflow** — nothing runs it. | verified (syntax passes) / orphaned (G9) |
| `tests/fixtures.mjs` † | Shared fixtures (appeared in final snapshot). | present (unaudited content) |
| `tests/perf.mjs` (16,317 B) | Live perf harness vs v1 baselines (health median, messages median, mail-visible worst case); explicitly reports "REGRESSION … /api/wait unavailable (v1 mode, 404)" when run against a v1 deploy — a good honest gate for after the v2 deploy. Not run by this audit. | verified (syntax passes) / not executed |

### 1.8 Docs

| File | Purpose | Status |
|---|---|---|
| `docs/ARCHITECTURE.md` (41,934 B) | v2 design contract: v1 perf diagnosis (measured 0.25–0.55 s health, ~10.6 s mail-visible), budgets, endpoint/index/header norms, rollout/rollback (§7.5). Careful and largely honest — but several of its normative v2 behaviours are **not implemented in `worker-v2.js`** (see G4): §6.2 one-JOIN auth+list, §6.3 single `DB.batch()` ingest with stored preview/otp. The document describes the target; the code implements roughly half of §6. | present (claims partially unimplemented) |
| `docs/API.md` (61,972 B) | Full API reference, v1 shapes sourced from the baseline file, v2 differences tagged `[v2]`. Includes a 429 rate-limit error row — rate limiting exists only in the un-deployed integrated file (G1), so against a deploy of `worker-v2.js` that row is aspirational. | present |
| `docs/openapi.yaml` † (18,148 B) | OpenAPI description (appeared mid-audit). Not cross-validated against the worker endpoint-by-endpoint in this audit. | present (unaudited content) |
| `docs/AUDIT-v2.md` | This file. | — |

### 1.9 CI/CD (`.github/workflows/`)

| File | Purpose | Status |
|---|---|---|
| `ci.yml` (4,681 B) | On PR/push: validate `wrangler.toml` (name/main/DB binding + entrypoint exists), `node --check` every JS file under `src ui packages tests`, inline unit smoke importing `parseRaw`/`extractOTP`/`extractLinks`/`extractVerificationLinks` from `src/worker-v2.js`. No secrets, no deploy. The smoke imports match the real exports — I verified the export names exist. Does not run `tests/ui.test.mjs`, the Rust tests, or the UI build. | present (logic checked by reading; never executed — no repo/Actions yet) |
| `build-wasm.yml` (2,466 B) | On `rust/**` changes: wasm32 toolchain, `wasm-pack build --target web --release`, `cargo test`, uploads `mail-parser-wasm` artefact (14-day retention). Note the step order: **build runs before `cargo test`**, so a test failure still costs a full release build first — cosmetic, not a defect. | present / never executed |
| `deploy.yml` (4,693 B) | On push to `main` / dispatch: optionally downloads the WASM artefact (warn-only if absent — honest), `wrangler deploy` via `cloudflare/wrangler-action@v3` using `secrets.CLOUDFLARE_API_TOKEN` + `secrets.CLOUDFLARE_ACCOUNT_ID`, then production smoke test (`/api/health` `ok:true` with 10×6 s retries, `/api/config` contains `turjaun.xyz`). Concurrency-guarded. **It does not apply any D1 schema/migration, does not run `build-ui.mjs`, and has no rollback step** — all three are claimed elsewhere (M3/M4). | present / never executed; **secrets unverified (G6)** |

---

## 2. Integration gaps — ranked

**G1 — CRITICAL: two divergent deployable workers; the deploy path picks
the lesser one.**
`src/worker-v2.js` (19,864 B) and `src/worker-v2-integrated.js` †
(35,149 B, ~379 diff lines) are both complete workers.
`worker-v2-integrated.js` is strictly ahead (inlined rate limiting +
webhooks). But every deploy reference points at `worker-v2.js`:
`wrangler.toml` `main`, `scripts/deploy-api.py` `WORKER_PATH`, `ci.yml`'s
smoke imports, `package.json` `check`. A grep for
`worker-v2-integrated` across the whole tree returns **zero references
outside the file itself**. Deploy today and rate limiting + webhooks
silently don't ship; worse, the two files will keep diverging.
*Fix: pick one canonical file (the integrated one, folded back into
`worker-v2.js`, or repoint all four references), delete the other.*

**G2 — CRITICAL: the new UI is built by nothing and served by nothing.**
`ui/*` (the actual v2 UI) reaches a user only via
`scripts/build-ui.mjs` → `src/worker-v2.built.js`. That output file does
not exist in the tree, `wrangler.toml` does not point at it, `deploy.yml`
never runs the build, and `deploy-api.py` uploads `worker-v2.js` raw.
Both worker files serve the shortened v1 placeholder UI — which still
rebuilds the inbox with `innerHTML` (the exact pattern ARCHITECTURE §1.4
criticises). The user's original complaint (slow, imperfect UI) survives
a deploy of this tree unchanged.
*Fix: run the build in the deploy path (CI step before wrangler, or in
`deploy-api.py`), point `main` at the built file, and add the built file
to `.gitignore` (or commit it deliberately — pick one).*

**G3 — HIGH: WASM parser is not wired into any worker.**
`worker-v2.js` parses mail with the JS `parseRaw`; the only trace of Rust
is the `RUST_WASM_HOOK` comment marking where a swap would go. There is
no `.wasm` in the tree, no import of `rust/mail-parser/pkg` anywhere, and
`deploy.yml`'s artefact download is explicitly warn-only with a JS
fallback message. The Rust crate itself is complete-looking and
test-covered (in-source), but it has never been compiled in this project
(no `Cargo.lock`, no local rustc by rule, `build-wasm.yml` never run).
README/ARCHITECTURE phrasing ("handles incoming mail on the ingest path
in v2") describes the intent, not the current wiring.
*Fix: after the repo exists, run `build-wasm.yml`, then do the
`parseRaw` swap behind the hook with the JS parser kept as fallback, and
gate it on the crate's fixture parity with `parseRaw`.*

**G4 — HIGH: the v2 schema is decorative — the worker never uses it.**
`schema-v2.sql` adds `mails.preview` and `mails.otp` "computed once at
ingest", and ARCHITECTURE §6.2/§6.3 normatively require one JOIN for
auth+list and one `DB.batch()` for ingest. In `worker-v2.js` (and in the
integrated file): the ingest `INSERT INTO mails` lists
`(address,sender,subject,text_body,html_body,raw_size)` — **no
preview/otp**; list queries still compute `substr(text_body,1,200) AS
preview` and `enrichMail()` re-runs OTP/link regexes over bodies on every
read; grep counts for `JOIN` and `.batch(` in `worker-v2.js` are both
**0** (auth+list is still two serial queries); and
`/api/inboxes/:address/messages` still selects full `text_body,html_body`
for a list — ARCHITECTURE §1.3's headline defect, unfixed in code. The
composite indexes would still help (the queries' `WHERE`/`ORDER BY`
shape matches), so a migration is not wasted — but the §1.6 budget claims
that depend on stored preview/otp and single-query reads are not met by
this code.
*Fix: write preview/otp in the ingest INSERT (from whichever parser
ran), select the stored columns with the documented
`COALESCE(preview, substr(text_body,1,200))` fallback, collapse auth+list
to the §6.2 JOIN, batch ingest per §6.3 — or downgrade the docs to match
the code. One of the two must happen before release claims are made.*

**G5 — HIGH: schema v2 is not applied to the live D1 (presumed).**
Live `temp-mail-db` runs the v1 schema. `db/migrate-v1-to-v2.sql` exists
and is the correct vehicle (not `schema-v2.sql`, which is fresh-install
only, and not `package.json`'s `db:init`, which runs `schema-v2.sql`
against the existing DB — its `CREATE TABLE IF NOT EXISTS` statements
would no-op and its `CREATE INDEX` statements would succeed, but the
`preview`/`otp` columns would never be added; see M7). `deploy.yml` has
no migration step. Because of G4's benign failure mode, nothing breaks
either way today — which is exactly how this gap stays invisible.
*Fix: integrator runs the migration once, remotely, and verifies with
`PRAGMA table_info(mails)` + `PRAGMA index_list(mails)` before deploying
v2 code.*

**G6 — HIGH: the GitHub repo and its secrets do not exist yet.**
There is no `.git` in this tree. The README badges, the
`turjaun985123/temp-mail-turjaun` repo name, and all three workflows
assume a repo that, as far as anything in this tree can show, has not
been created or pushed to. Consequently `deploy.yml`'s required secrets
— `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit, D1 Edit, Workers Routes
Edit, Email Routing Rules Edit, Zone Read) and `CLOUDFLARE_ACCOUNT_ID` —
**cannot have been set in that repo** and are unverified. Until they are,
the "CI-only deploy" story (ARCHITECTURE §7.1) cannot run at all, and the
only working deploy path remains `scripts/deploy-api.py` with a locally
held token (the proven v1 method).
*Fix: create `turjaun985123/temp-mail-turjaun`, push this tree (minus
G10 junk), set both secrets, confirm the account ID matches
`079c053e14d1aa42628ca4b62f2b492a` (the value hard-coded as the default
in `deploy-api.py`).*

**G7 — MEDIUM: `src/sse.js` is dead code by design, but it will confuse
every future reader.** It proposes a `/api/stream` route that no worker
implements and its own header recommends against using it as the default.
Keep it only if the integrator explicitly wants the option documented in
code; otherwise move it to `docs/` as a design note. Not a release
blocker.

**G8 — MEDIUM: auth posture is inherited, not reviewed.**
In `worker-v2.js`, `GET /api/mail/:id`, `GET /api/inboxes/:address/
messages`, and `DELETE /api/mail/:id` perform **no token check** (the
address/ID is effectively the credential) — identical to v1, and
`resolveAddress()` even accepts `?address=` as an alternative to a token
on `/api/wait`. AGENTS.md §3 meanwhile states DELETE requires auth and
tells agents to send the header on all calls. Either the code gains the
checks AGENTS.md promises, or AGENTS.md/API.md must state plainly that
message read/delete are unauthenticated-by-design (as v1 was). Shipping
the current ambiguity is the worst option. (Pre-existing v1 behaviour —
flagged, not introduced by v2.)

**G9 — MEDIUM: test coverage is wired for exactly one suite.**
`npm test` runs only `tests/api.test.mjs` (live, post-deploy by design).
`tests/ui.test.mjs` and `tests/fixtures.mjs` are referenced by nothing;
`ci.yml`'s inline smoke is the only pre-deploy test that can ever run,
and it imports from `worker-v2.js` — if G1 is resolved in favour of the
integrated file, the smoke test must follow it or it will test the wrong
worker. `tests/perf.mjs` is the right post-deploy gate and should be run
once against production after the v2 deploy to confirm the §1.6 budgets.

**G10 — LOW: repo hygiene.**
`scripts/__pycache__/*.pyc` (2 files) present and not git-ignored; no
`LICENSE` file despite the MIT badge/claim; `Cargo.lock` missing;
`src/worker-v2.built.js` neither git-ignored nor generated. All
five-minute fixes at push time.

**G11 — LOW: `build-wasm.yml` runs the release build before
`cargo test`.** A failing test suite is discovered only after the
expensive wasm-pack release build. Swap the steps when convenient.

---

## 3. Consistency checks actually run

Commands: recursive `grep` over the tree (excluding nothing — there is no
`node_modules` present), `node --check` on every `.js`/`.mjs` (via `.mjs`
copies), `python3 -m py_compile` on both `.py` scripts, a scratch-copy
run of `scripts/build-ui.mjs`, and `diff` between the two worker files.

| # | Check | Result |
|---|---|---|
| C1 | Domain `turjaun.xyz` | **Consistent.** 127 references; the single configured value agrees everywhere it matters: `wrangler.toml` `DOMAINS`, both workers' fallback, `deploy-api.py`, UI, docs, tests. The only other domain string in a config-like context is README's generic `yourdomain.com` example (M2). |
| C2 | D1 database ID | **Consistent.** `324a85a1-e2a8-417e-883b-4b23e060fbce` appears exactly twice — `wrangler.toml:34` and `scripts/deploy-api.py:47` — identical. No other UUID-shaped string anywhere in the tree. Database name `temp-mail-db` and binding `DB` agree in `wrangler.toml`, `package.json` scripts, CI's binding grep, and both deploy paths. |
| C3 | Worker name | **Consistent.** `temp-mail` in `wrangler.toml`, `ci.yml`'s assertion, `deploy-api.py` `SCRIPT_NAME`, docs. |
| C4 | Base URL | **Consistent.** Exactly one variant in the entire tree: `https://temp-mail.turjaun.workers.dev` (50 occurrences). No stray subdomain, no `www`, no trailing-path variants in config positions. |
| C5 | Account ID | **Single-sourced, unverifiable here.** `079c053e14d1aa42628ca4b62f2b492a` appears only as `deploy-api.py`'s default (env-overridable). It matches the account that owns the live v1 service from the v1 deploy, but `deploy.yml` will use the `CLOUDFLARE_ACCOUNT_ID` secret instead — the integrator must confirm they are the same account (G6). |
| C6 | GitHub repo identity | **Consistent but prospective.** All 6 `github.com/…` references are `turjaun985123/temp-mail-turjaun`. The repo is referenced by badges/docs only; this tree is not yet a git checkout of it (G6). |
| C7 | Syntax | **All pass.** `node --check`: `worker-v2.js`, `worker-v2-integrated.js`, `worker-v1-baseline.js`, `rate-limit.js`, `sse.js`, `webhooks.js`, `ui/app.js`, `packages/node-client/index.js`, `scripts/build-ui.mjs`, `tests/api.test.mjs`, `tests/ui.test.mjs`, `tests/perf.mjs`, `examples/node-signup-otp.mjs`. `py_compile`: `deploy-api.py`, `d1-maintenance.py`. |
| C8 | UI build | **Works, unused.** Scratch-copy run of `build-ui.mjs` produced a syntax-valid `src/worker-v2.built.js` (60,334 B). Nothing consumes it (G2). |
| C9 | Duplication | **`worker-v2-integrated.js` exists** (it appeared during this audit) and duplicates `worker-v2.js` with ~379 diff lines (inlined rate-limit + webhooks). Zero references to it anywhere else. This is the G1 hazard, confirmed, not hypothetical. There is no `worker-v2.built.js` duplication yet — it would become a third variant the moment someone runs the UI build locally. |
| C10 | Endpoint surface | **Consistent across worker / AGENTS.md / node-client.** `/api/health`, `/api/config` (+`/api/domains` alias), `/api/new_address`, `/api/mails`, `/api/inboxes/:address/messages`, `/api/mail/:id` (GET/DELETE), `/api/wait`. Client and agent docs use only endpoints the worker implements. `/api/stream` (SSE) is implemented nowhere, and `sse.js` itself says so. |

### Mismatches found

- **M1 — README quickstart domain example (minor).** README ~line 299
  shows `DOMAINS = "yourdomain.com"` and ~line 351 a health example with
  `"domain":["yourdomain.com"]`. Generic-template residue in a repo whose
  actual domain is fixed; harmless if read as an example, confusing in a
  repo that is itself the deployed service's home.
- **M2 — README quickstart schema paths are wrong (real).** README
  ~lines 290–292 instruct `wrangler d1 execute … --file=db-schema-v1.sql`
  then `--file=db-schema-v2.sql`. No file named `db-schema-v2.sql` exists:
  the v2 fresh schema is `db/schema-v2.sql`, and upgrading the live DB
  requires `db/migrate-v1-to-v2.sql`, which the quickstart never mentions.
  A user following the README literally fails on the second command, and
  would still not have migrated if they guessed the path (see G5/M7).
- **M3 — README feature claims vs wired reality (real).** README states
  as v2 facts: Rust WASM parser "handles incoming mail on the ingest
  path", "OTP and preview computed once, at ingest — stored as columns",
  "auth + list collapse … into one JOIN", "ingest is a single
  `DB.batch()`", and "CI-only deploys — GitHub Actions builds the Rust
  parser, runs tests, applies D1 migrations, deploys …, and rolls back
  on failure." Per G3/G4 and the `deploy.yml` read: none of the five is
  true of the current wiring (no WASM import, no stored columns written,
  zero JOIN/batch in the worker, `deploy.yml` has no migration and no
  rollback step). The README describes the ARCHITECTURE target state.
- **M4 — README project-structure section is stale (real).** It lists
  `db-schema-v2.sql` at root (doesn't exist, see M2), omits
  `db/schema-v2.sql`, `db/migrate-v1-to-v2.sql`, `src/rate-limit.js`,
  `src/sse.js`, `src/webhooks.js`, `src/worker-v2-integrated.js`,
  `scripts/build-ui.mjs`, `scripts/d1-maintenance.py`, `tests/ui.test.mjs`,
  `tests/perf.mjs`, `tests/fixtures.mjs`, `docs/openapi.yaml`,
  `examples/`; describes `ci.yml` as running "JS tests, fixtures, bundle
  & query-plan checks" (it runs none of those — it validates config,
  syntax-checks, and runs one inline smoke); describes the Rust export as
  `parseMime(bytes) -> {…, otp, rawSize}` (no such function/shape, §1.5).
- **M5 — AGENTS.md auth table vs worker code (real, pre-existing).**
  AGENTS.md §3/§4 mark `DELETE /api/mail/:id` as auth-required and
  `GET /api/mail/:id` / inbox-messages as "send the header anyway"; the
  worker performs no auth check on any of the three (G8). Agents
  following AGENTS.md are safe; anyone trusting it as a security
  description is misled.
- **M6 — ARCHITECTURE §6 vs worker code (real).** See G4: §6.2 JOIN,
  §6.3 batch + stored preview/otp, and §3.3's preview-only list shape for
  `/api/inboxes/:address/messages` are normative in the doc and absent in
  the code (that endpoint still ships full bodies). Also §1.6's
  "`next_since_id` cursor" (echoed in README) is not emitted by
  `worker-v2.js` list/wait responses — they emit `next_before_id` and
  `latest_id` (a client can derive the cursor from `latest_id`, and
  AGENTS.md's workflow does not depend on the field name, but the named
  field does not exist).
- **M7 — `package.json` `db:init` is the wrong tool for the live DB
  (real).** `npm run db:init` applies `db/schema-v2.sql` (fresh-install)
  to the existing v1 database. As analysed in G5 it would create the new
  indexes but never add `preview`/`otp`. The script is correct for a
  brand-new database only; nothing in `package.json` runs the migration
  file. Add a `db:migrate` script so the distinction is executable, not
  tribal knowledge.

---

## 4. Release readiness

### Verdict: READY WITH GAPS

**Why not READY:** the thing that would actually deploy (G1+G2) is not
the thing the release is about. Shipping today gives users the v1 UI and
the un-integrated worker, leaves rate limiting/webhooks/WASM/stored-OTP
on the cutting-room floor, against a database whose v2 migration has not
been run (G5), through a CI pipeline whose repo and secrets don't exist
yet (G6) — while the README announces all of it as shipped (M3). That is
a release that would generate exactly the "it's still slow / not as
described" report that prompted v2.

**Why not NOT READY:** the substance is genuinely here and checked.
Every code file parses; the core worker's new endpoints (`/api/wait`,
cursors, ETags) are implemented, not stubbed; the UI, client, Rust crate,
schema, migration, build script (executed successfully), and both deploy
paths (Wrangler CI + proven API script) all exist and agree on the
constants that matter (C1–C4). The remaining work is integration and
honesty-of-docs, measured in hours, not a rebuild. The service also
cannot regress below v1 by deploying `worker-v2.js` as-is: it preserves
every v1 endpoint and runs against the v1 schema.

### Exact remaining integrator steps (in order)

1. **Collapse to one worker (G1).** Merge `worker-v2-integrated.js`'s
   inlined rate-limit/webhook blocks into `src/worker-v2.js` (or rename
   the integrated file over it), delete the duplicate, and confirm
   `grep -rn "worker-v2" wrangler.toml package.json scripts/ .github/`
   names exactly one file. Re-run `npm run check` and the CI smoke
   imports against the survivor.
2. **Wire the UI (G2).** Add `node scripts/build-ui.mjs` as a step in
   `deploy.yml` before the Wrangler deploy (and in `deploy-api.py` if it
   stays a supported path), point the deploy at
   `src/worker-v2.built.js`, git-ignore the built file, and verify the
   served `/` HTML contains the `ui/app.js` long-poll code, not the
   placeholder.
3. **Migrate the live database (G5, M7).** Add
   `"db:migrate": "wrangler d1 execute temp-mail-db --remote --file=db/migrate-v1-to-v2.sql"`
   to `package.json`; run it once against `temp-mail-db`; verify
   `PRAGMA table_info(mails)` lists `preview` and `otp` and
   `PRAGMA index_list(mails)` lists `idx_mails_address_id` and
   `idx_mails_created_id`. Only then is `db:init`'s fresh-install role
   unambiguous.
4. **Close the schema/code gap (G4) or re-scope the claims.** Preferred:
   implement §6.3 ingest (single batch; insert `preview`/`otp`), §6.2
   JOIN for auth+list, stored-column selects with the `COALESCE`
   fallback, and preview-only shape for `/api/inboxes/:address/messages`.
   Minimum acceptable: edit README + ARCHITECTURE to mark those four
   items as "designed, not yet implemented" before any public release.
5. **Create the repo and secrets (G6).** `git init`, remove
   `scripts/__pycache__/` and add it (plus `src/worker-v2.built.js`) to
   `.gitignore`, add a real `LICENSE` (MIT), generate and commit
   `rust/mail-parser/Cargo.lock`; create GitHub repo
   `turjaun985123/temp-mail-turjaun`, push, set secrets
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   (= `079c053e14d1aa42628ca4b62f2b492a`); watch the first `ci.yml` run go
   green.
6. **Decide WASM for this release (G3).** Either (a) run
   `build-wasm.yml`, complete the `RUST_WASM_HOOK` swap with JS fallback
   and fixture parity, or (b) explicitly ship v2.0 as "JS parser, WASM
   ready" and correct the README present-tense WASM claims (M3). Do not
   ship the current ambiguity.
7. **Fix the docs mismatches (M1–M6).** README quickstart schema
   commands → `db/migrate-v1-to-v2.sql` for existing installs;
   regenerate the project-structure tree from the real tree; align
   AGENTS.md/API.md auth wording with the code (or implement the checks,
   G8); correct the Rust export name/shape; remove or implement
   `next_since_id`.
8. **Wire the orphan tests (G9).** Add `tests/ui.test.mjs` to a script
   (e.g. `test:unit`) and to `ci.yml`; keep live `api.test.mjs`/`perf.mjs`
   as the post-deploy gate.
9. **Deploy and prove it.** Deploy via the (now real) `deploy.yml`;
   confirm its smoke test passes; then run, against production:
   `TEMP_MAIL_BASE=https://temp-mail.turjaun.workers.dev npm test` and
   `npm run perf`. Acceptance: `/api/wait` returns non-404 and perf
   reports mail-visible improvement over the 10.6 s v1 worst case, health
   and list medians at or under the ARCHITECTURE §1.6 budgets. Send a
   real mail to a fresh `@turjaun.xyz` inbox and confirm it appears via
   `/api/wait` in ≤ ~1 s in the new UI.
10. **Housekeeping (G7, G10, G11).** Decide `sse.js`'s fate (keep as
    documented option or move to docs), swap `build-wasm.yml`'s
    test/build order, and confirm the catch-all rule and the
    `me@turjaun.xyz` forwarding rule in Email Routing are untouched by
    the v2 rollout.

*End of audit.*
