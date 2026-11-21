# Temp Mail v2 — Production Checklist

> **Scope:** Production hardening, observability, scaling, and rollback for the
> live Temp Mail service.
>
> **Live facts (verified in v1, carried into v2):**
>
> | Item | Value |
> |---|---|
> | Worker | `temp-mail` |
> | Worker URL (default) | `https://temp-mail.turjaun.workers.dev` |
> | Intended custom domain | `mail.turjaun.xyz` (see §1) |
> | Mail domain | `turjaun.xyz` |
> | Cloudflare account | `Myeasin985@gmail.com's Account` |
> | Email ingress | Cloudflare Email Routing, **catch-all → Worker `temp-mail`, enabled** |
> | Preserved rule | `me@turjaun.xyz` → personal forwarding — **do not break or repurpose** |
> | Database | D1 `temp-mail-db` — tables `addresses`, `mails` (+ indexes) |
> | Retention | Mails auto-deleted after `MAIL_TTL_HOURS` (v1 default: 24 h) by hourly cron |
> | Health endpoint | `GET /api/health` → `{"ok":true,"service":"temp-mail",...}` |
>
> This document is a checklist, not a deploy log. An item is only **Done**
> when it has been verified against the live artifact (dashboard, HTTP
> response, D1 query, or log) — never because a config field exists.
> That rule is a direct lesson from the v1 “Hello World” incident (§8.3).

---

## 1. Custom domain for the Worker — `mail.turjaun.xyz`

The `*.workers.dev` URL works, but production traffic, bookmarks, API
clients, and CORS allowlists should use a first-party hostname.

### 1.1 Attach the custom domain (Workers Triggers)

1. Cloudflare Dashboard → **Workers & Pages → `temp-mail` → Settings →
   Triggers → Custom Domains → Add Custom Domain**.
2. Enter exactly: `mail.turjaun.xyz`.
3. Confirm. Cloudflare provisions the route and a managed certificate
   automatically because `turjaun.xyz` is already a zone in the same account
   (nameservers `kenia.ns.cloudflare.com` / `renan.ns.cloudflare.com`).
4. Wait for the certificate status to show **Active** before announcing
   the URL. Do not announce on “pending”.

Programmatic equivalent (Wrangler / API deploys must not drop it):

- In `wrangler.toml`, keep the custom domain declared so a redeploy does
  not silently detach it:

  ```toml
  [[routes]]
  pattern = "mail.turjaun.xyz"
  custom_domain = true
  ```

- If routes are managed only in the dashboard, add a pre-deploy check:
  after every deploy, `GET https://mail.turjaun.xyz/api/health` must
  return `ok:true` (see §6.1) before the deploy is called successful.

### 1.2 DNS note

- **Do not hand-create an A/AAAA record for `mail` pointing at a guessed
  IP.** A Workers Custom Domain creates and manages its own DNS record
  (a proxied placeholder record owned by Cloudflare). A conflicting manual
  record will either block attachment or be overwritten/conflict.
- Before attaching: Dashboard → **DNS → Records** — check there is no
  existing `mail` A, AAAA, or CNAME record. If one exists from an older
  experiment, remove or repurpose it deliberately and note it in the
  change log; do not leave two owners for the same name.
- `mail.turjaun.xyz` is the **HTTP/API hostname only**. It is unrelated to
  mail delivery:
  - MX records for `turjaun.xyz` must stay pointed at Cloudflare Email
    Routing (`route1/2/3.mx.cloudflare.net`) — **never** point MX at
    `mail.turjaun.xyz`.
  - Do not add `mail.turjaun.xyz` as a second mail domain unless Email
    Routing, `DOMAINS`, SPF, and the catch-all are all updated together.
- After attachment, verify resolution and TLS from outside Cloudflare:

  ```bash
  curl -s https://mail.turjaun.xyz/api/health
  # expect: {"ok":true,"service":"temp-mail","domain":["turjaun.xyz"],...}

  curl -s https://temp-mail.turjaun.workers.dev/api/health
  # workers.dev URL must keep working as the fallback / rollback URL
  ```

### 1.3 Cutover

- [ ] Custom domain attached and certificate **Active**
- [ ] `https://mail.turjaun.xyz/api/health` returns `ok:true`
- [ ] UI loads at `https://mail.turjaun.xyz/` (not “Hello World!”)
- [ ] API docs / `AGENTS.md` examples updated to the custom domain,
      with the `workers.dev` URL kept as fallback
- [ ] Any hardcoded `temp-mail.turjaun.workers.dev` references in clients
      inventoried before they are changed — one hostname change at a time

---

## 2. Cloudflare WAF and rate limiting

Goal: temp mail is abusable by design (anyone can mint inboxes). The
controls below protect the API and D1 without breaking legitimate
“create inbox → wait for OTP” flows.

All rules live in: Dashboard → **`turjaun.xyz` zone → Security → WAF**
for firewall rules, and **Security → WAF → Rate limiting rules** (or
Security → Rate limiting, depending on dashboard version) for rate
limits. Custom-domain traffic for `mail.turjaun.xyz` is zone traffic, so
zone rules apply. Traffic that only hits `*.workers.dev` bypasses zone
WAF — another reason production clients must use the custom domain (§1).

### 2.1 Rate-limiting rules to add

Create these in order; most specific first. Counts are starting values
for a personal / small-public deployment — tune from logs (§5), do not
guess-tune blind.

| # | Name | Match | Limit (starting point) | Action | Why |
|---|---|---|---|---|---|
| R1 | `temp-mail: create-address burst` | Hostname = `mail.turjaun.xyz` **AND** Path = `/api/new_address` **AND** Method = `POST` | 10 requests / 1 minute / IP | Block (or Managed Challenge if a browser UI shares the IP pool) | Address minting is the cheapest abuse vector and drives D1 writes |
| R2 | `temp-mail: create-address sustained` | Same as R1 | 100 requests / 10 minutes / IP | Block for 10 minutes | Stops slow-drip minting that stays under R1 |
| R3 | `temp-mail: inbox reads` | Hostname = `mail.turjaun.xyz` **AND** Path starts with `/api/mails` **OR** Path matches `/api/inboxes/*/messages` | 120 requests / 1 minute / IP | Log first, then Block after a week of clean data | Headroom is for multiple tabs / clients, not scrapers. Per `AGENTS.md`, API agents must **not** timer-poll these endpoints — they use the single-request long-poll `GET /api/wait` (one request per wait cycle, never parallel). Do not rate-limit `/api/wait` as if it were rapid polling: it is one held request per cycle by design; protect it with concurrency/abuse controls in the Worker, not a low per-minute count that breaks the wait flow |
| R4 | `temp-mail: single-mail fetch` | Hostname = `mail.turjaun.xyz` **AND** Path matches `/api/mail/*` | 120 requests / 1 minute / IP | Block | Prevents ID enumeration storms at the edge |
| R5 | `temp-mail: global API ceiling` | Hostname = `mail.turjaun.xyz` **AND** Path starts with `/api/` | 600 requests / 1 minute / IP | Managed Challenge, then Block if abuse is observed | Catch-all backstop; must sit **below** (evaluated after) R1–R4 |

Notes:

- **Characteristics:** count by **IP** (add “with the same characteristics”
  defaults). Do not rate-limit by address/token at the WAF layer — tokens
  belong in Worker-side auth checks.
- **Period / mitigation timeout:** use the shortest dashboard-supported
  period for R1 and a real timeout (not “challenge forever”) for R2/R5 so
  shared NAT / mobile IPs are not punished indefinitely.
- **Exemptions:** do **not** exempt `/api/health` from all rules — leave
  it under R5 so a health-check flood is still capped — but ensure the
  uptime checker in §6 uses a low frequency (1–5 min) from a stable IP so
  it never trips R3–R5.
- **Email ingress is not HTTP.** WAF/rate limiting does **not** throttle
  inbound SMTP via Email Routing. Mail-volume abuse is controlled by
  retention (§4), message-size handling in the Worker, and Cloudflare
  Email Routing limits (§7) — do not claim WAF protects the inbox path.

### 2.2 WAF custom (firewall) rules to add

| # | Name | Expression (conceptual) | Action |
|---|---|---|---|
| W1 | Block non-API writes to read-only surface | `mail.turjaun.xyz` + method in (`PUT`, `PATCH`) on `/api/*` | Block |
| W2 | Challenge obvious scanner paths | Path contains `/.env`, `/.git`, `/wp-admin`, `/phpmyadmin` on `mail.turjaun.xyz` | Block |
| W3 | Geo / ASN policy (only if the owner wants it) | Country / ASN not in the owner's expected set **and** `POST /api/new_address` | Managed Challenge — **off by default**; enabling it is an owner decision, it will break travellers/VPN users |

- Keep W1–W2 in **Log** mode for the first 24 h if the dashboard supports
  it, review hits in **Security → Events**, then switch to Block.
- Every rule change gets a line in the change log: date, rule, before,
  after, and the log evidence that justified it.

### 2.3 Verify the rules work

```bash
# R1 smoke test (from a disposable IP / local machine, off-peak):
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    https://mail.turjaun.xyz/api/new_address \
    -H "Content-Type: application/json" \
    -d '{"domain":"turjaun.xyz"}'
done
# expect: first requests 200, then 429 / 403 once the R1 threshold is hit
```

Record the observed status codes. “Rule exists in dashboard” is not
verification.

---

## 3. Bot Fight Mode considerations

Dashboard: **`turjaun.xyz` zone → Security → Bots → Bot Fight Mode**
(Free-plan Bot Fight Mode; Super Bot Fight Mode settings differ on paid
plans).

- **Default recommendation: keep Bot Fight Mode ON for the zone, but
  validate the API after enabling.** Bot Fight Mode challenges traffic it
  classifies as “definitely automated”. Legitimate Temp Mail API clients
  (scripts, test automation, the agent integration in `AGENTS.md`) are
  also automated and can be challenged — a challenge page returned to an
  API client looks like a broken API (HTML instead of JSON).
- Known interactions to check explicitly after any bot-setting change:
  1. `curl` create-address and inbox-poll flows from §2.3 still return JSON.
  2. The first-party UI at `mail.turjaun.xyz/` still loads and polls —
     browser traffic should pass; if it does not, the problem is bot
     classification, not the Worker.
  3. The external uptime checker (§6) still sees `200` on `/api/health`.
- If API clients are being challenged:
  - Prefer, in this order: (a) a WAF **Skip** rule scoped narrowly to
    `mail.turjaun.xyz` + `/api/*` + the known client IP range / a shared
    secret header the Worker also validates, skipping only Bot Fight /
    managed-challenge components — never a blanket skip for all security
    features; (b) move programmatic clients to a dedicated hostname if
    one is later added; (c) only as a last resort, turn Bot Fight Mode
    off for the zone and document that R1–R5 + W1–W2 are then the sole
    edge controls.
  - **Never** “fix” bot challenges by disabling WAF rate limiting ( §2).
- Bot Fight Mode does **not** inspect inbound email. It has no effect on
  OTP delivery, spam to inboxes, or the Email Routing → Worker path.
- Free Bot Fight Mode cannot be fine-tuned per-path the way Super Bot
  Fight Mode can. If per-path bot policy becomes a requirement, that is
  an explicit upgrade trigger (§7.2).

---

## 4. D1 monitoring — `temp-mail-db`

### 4.1 What to watch

| Signal | Where | Healthy | Investigate when |
|---|---|---|---|
| Database size | Dashboard → Workers & Pages → D1 → `temp-mail-db` (overview / metrics) | Well under quota (§7), roughly flat day-over-day because of TTL cleanup | Monotonic growth over 24–48 h — cleanup is failing or retention was raised without a plan |
| Row count — `mails` | D1 Console query (below) | Rises during the day, falls after cleanup | Never falls |
| Row count — `addresses` | D1 Console query (below) | Bounded by address expiry | Grows without bound — addresses are being minted and never expiring (abuse or missing expiry) |
| Read / write operations | D1 metrics in dashboard | Proportional to API + email volume | Writes spike without matching email/API traffic (minting abuse → check R1/R2) |
| Query errors | Worker logs (§5) during D1 calls | Zero | Any `UNIQUE`, binding, or “no such table” errors after a deploy — schema/binding drift |

Console checks (D1 → `temp-mail-db` → Console):

```sql
SELECT COUNT(*) AS mails FROM mails;
SELECT COUNT(*) AS addresses FROM addresses;
SELECT COUNT(*) AS expired_mails_still_present
FROM mails
WHERE created_at < unixepoch() - 24 * 3600;  -- adjust 24 to MAIL_TTL_HOURS

SELECT address, COUNT(*) AS n
FROM mails GROUP BY address ORDER BY n DESC LIMIT 10;  -- noisy inboxes / abuse concentration
```

### 4.2 Cleanup cron verification

The hourly scheduled handler is the only thing enforcing retention.
“Cron trigger exists” is not proof it runs — verify all three layers:

1. **Trigger present:** Worker → Settings → Triggers → Cron shows
   `0 * * * *` (hourly). If deploys are Wrangler/API-managed, confirm the
   schedule survived the last deploy (API deploys can replace triggers —
   re-check after every deploy, §8).
2. **It executes:** Dashboard → Worker → Logs / Observability, or
   `wrangler tail` (§5) across an hour boundary — look for the scheduled
   event firing, with no exception.
3. **It deletes:** run the `expired_mails_still_present` query twice,
   at least one cron period apart. The count must trend to ~0 after a
   run. A trigger that fires but deletes nothing is a failed control
   (wrong TTL env, wrong timestamp column, silent exception — check logs).

Also verify the Worker’s effective `MAIL_TTL_HOURS` in the deployed
environment (Dashboard → Worker → Settings → Variables, or the deploy
artifact), not just in the local `wrangler.toml`. v1 set `DOMAINS` and
`MAIL_TTL_HOURS` as dashboard variables **and** in deploy metadata —
if the two ever disagree, the deployed value wins and must be the one
documented.

### 4.3 Cadence

- **Weekly (5 min):** DB size, `mails`/`addresses` counts, expired-row
  query, D1 ops graph. Log the numbers; trend matters more than any
  single reading.
- **After every deploy:** §4.2 steps 1–3, abbreviated (trigger present +
  one expired-row query).
- **Before raising retention** (`MAIL_TTL_HOURS` > 24): estimate growth
  from the weekly numbers first. Retention is the storage knob.

---

## 5. Logs — `wrangler tail` and observability

### 5.1 Live tail (first tool during any incident)

```bash
# From the v2 project directory, authenticated to the owner's account:
npx wrangler tail temp-mail

# Useful filters:
npx wrangler tail temp-mail --status error
npx wrangler tail temp-mail --search "email"        # ingress path
npx wrangler tail temp-mail --format pretty
```

- Tail shows fetch, email, and scheduled invocations — label which
  handler you are looking at before drawing conclusions. A healthy HTTP
  log says nothing about the email handler.
- Tail is live-only and stops when the command stops. It is a debugging
  tool, not a log store.

### 5.2 Dashboard observability

- Dashboard → **Workers & Pages → `temp-mail` → Logs / Observability**:
  confirm Workers Logs is **enabled** for this Worker (head-based
  sampling is acceptable; keep invocation logs on). If logs were disabled
  to save quota, say so in the change log — silent loss of observability
  during the next incident is worse than the saving.
- What to look for, by symptom:
  - *Mail not arriving:* email-handler invocations present at all?
    If none → Email Routing / catch-all problem, not Worker code.
    If present with exceptions → parser / D1 write path.
  - *API slow (the v2 motivation):* invocation duration and CPU time per
    route. Compare `/api/mails` and `/api/inboxes/*/messages` against
    `/api/health`. Slowness concentrated in inbox reads points at query
    shape / payload size (full bodies on list endpoints), not at
    Cloudflare. Any Rust/Wasm parser or Node optimisation work must be
    justified by these numbers, per route, before and after.
  - *Create-address failures:* D1 errors and R1/R2 WAF blocks (§2) look
    identical to a client (“it failed”) — separate them by checking
    Security Events (edge block) vs Worker logs (origin error) first.
- **PII discipline:** logs must not contain full message bodies, OTPs,
  or inbox tokens. Log IDs, addresses’ domains, counts, durations, and
  error classes. If a debug change adds body/token logging, it is
  removed in the same change that fixes the bug — no exceptions.

### 5.3 Retention of evidence

- For any incident, save: timestamp (with timezone), the health-check
  output, one representative log excerpt (redacted per §5.2), D1 counts
  (§4.1), and the deployment ID that was live. File it with the rollback
  record if a rollback happened (§8).

---

## 6. Alerting on `/api/health`

The Worker cannot reliably alert on its own total failure (if it is
down, its alert code is down). Alerting must be **external**.

### 6.1 Uptime checker setup

Use any external checker the owner controls (e.g. UptimeRobot,
Better Stack, healthchecks.io, or a self-hosted Uptime Kuma on a
non-Cloudflare host). One monitor, configured exactly:

| Setting | Value |
|---|---|
| URL | `https://mail.turjaun.xyz/api/health` (fall back to the `workers.dev` URL only until §1 is Done) |
| Method | `GET` |
| Interval | 5 minutes (1 minute if the plan allows and R5 headroom is confirmed) |
| Success condition | HTTP `200` **AND** response body contains `"ok":true` — a bare 200 check would have passed the “Hello World!” default Worker and must not be used |
| Failure threshold | 2 consecutive failures (avoids paging on a single edge blip) |
| Alert channel | Owner's email as minimum; add SMS/push only if the owner wants pages for a personal temp-mail service |
| Second monitor (recommended) | Same checks against `https://temp-mail.turjaun.workers.dev/api/health` — divergence between the two isolates custom-domain/DNS problems from Worker problems |

### 6.2 What the health alert does and does not cover

- **Covers:** Worker deployed-but-wrong (Hello World class), Worker
  down, custom-domain/TLS breakage, account-level Workers outage.
- **Does not cover:** email ingress (a Worker can be healthy over HTTP
  while Email Routing is misconfigured), D1 growth, or cron failure.
  Those are covered by §4 checks and by a periodic end-to-end mail test:
  send a message to a known test address on `turjaun.xyz` and assert it
  appears via `/api/inboxes/<address>/messages` within a few minutes.
  Automate this only if the checker/tooling supports the full flow;
  otherwise it is a manual weekly check, recorded as such — do not claim
  it is monitored if it is manual.
- **Runbook on alert:** (1) curl both health URLs (§6.1) and compare;
  (2) check Cloudflare status + Worker logs (§5); (3) identify the live
  deployment ID; (4) if the bad state came from the last deploy, roll
  back (§8) before debugging forward.

---

## 7. Scaling limits — free tier and upgrade triggers

Quotas change; the numbers below are the planning values for the
Cloudflare **free** tier at v1 launch. Re-verify against Dashboard →
Workers & Pages → your plan / D1 overview before quoting them to anyone,
and date any re-verification in the change log.

### 7.1 Free-tier quotas that bound this service

| Resource | Free-tier planning value | How Temp Mail consumes it | First symptom at the wall |
|---|---|---|---|
| Workers requests | 100,000 / day | Every UI poll, API call, and health check | `429`/error responses, dashboard quota warning |
| Worker CPU time | 10 ms / invocation (free) | MIME parsing on the email handler is the CPU-heaviest path | Email-handler timeouts / dropped parses on large or complex messages |
| Workers Logs / observability | Plan-dependent retention & volume | Always-on logging (§5.2) | Log gaps, sampling |
| D1 storage | 500 MB per database (free) | Stored mail bodies (text + HTML) until TTL cleanup | Inserts fail when full — **mail stops arriving** |
| D1 rows read / written | 5 M reads / 100 k writes per day (free, planning values) | List endpoints read rows; every inbound mail + minted address writes | Throttled/failed queries under polling load |
| D1 databases | 10 / account (free) | 1 used (`temp-mail-db`) | — |
| Email Routing | Free; inbound only; per-message and routing limits set by Cloudflare | All ingress | Messages rejected/dropped upstream — invisible in Worker logs |
| Cron triggers | Included; hourly cleanup is 24 invocations/day | Retention (§4.2) | Negligible until many Workers share the account |

Design consequences already baked in:

- **Inbox-read traffic is the request-budget driver**, not email
  volume. The v1 UI polling every 10 s was ~8,640 requests/day per
  always-open tab and was a known slowness/quota cost. v2's answer is
  the `AGENTS.md` contract — `GET /api/wait` long-poll, one request per
  wait cycle — plus caching headers / conditional requests where they
  help. Any remaining polling must be measured per route (§5.2) and
  justified; performance work pays for itself in quota before it pays
  in milliseconds.
- **HTML bodies are the storage driver.** Storing full HTML + text for
  every message until TTL is what fills 500 MB. Any v2 change that
  truncates, compresses, or separates body storage must be measured
  against real D1 size data (§4.1), not assumed.
- **CPU is the parser driver.** The 10 ms free CPU budget is why a
  Wasm/Rust MIME parser is attractive for the email handler. It is an
  optimisation with a quota justification, not a rewrite licence:
  ship it behind the same API and the same parity tests as the JS parser.

### 7.2 When to upgrade (Workers Paid / plan changes)

Upgrade is justified when **any** of these is observed in the §4/§5
data — not before, and not “just in case”:

- [ ] Workers daily requests regularly exceed ~70% of the free quota,
      or a single abuse day exhausts it (check R1–R5 first — paying to
      serve abuse is the wrong fix)
- [ ] D1 size regularly exceeds ~350 MB despite verified TTL cleanup,
      or retention > 24 h becomes a real product requirement
- [ ] D1 write quota is hit on legitimate mail volume
- [ ] Email-handler CPU timeouts appear in logs on legitimate mail
      (after parser optimisation has been tried and measured)
- [ ] Per-path bot management (§3) or higher WAF rate-limit rule counts
      become necessary
- [ ] Log retention is needed beyond the free observability window for
      incident investigation

Workers Paid raises, among other things, request allowances, CPU time
per invocation (to tens of ms by default, configurable higher), and D1
storage/operations by orders of magnitude. Re-check the current plan
page at upgrade time; do not copy numbers from this document into a
purchase decision.

**Cost discipline:** the owner has previously declined paid plans when
money was a constraint. Present an upgrade as a measured proposal
(quota graph + symptom + plan price at the time), never as an automatic
step in a deploy runbook.

---

## 8. Rollback plan

### 8.1 Principles

1. **Every deploy is reversible or it is not done.** Before deploying,
   record the currently live deployment ID and confirm the previous
   artifact (source tree / Wrangler version / API-uploaded module) is
   available locally or in version control.
2. **Verify the thing you just deployed, on the live URL, immediately**
   (§8.3). A deploy with no post-deploy health + API + email-handler
   check is an unfinished deploy.
3. **Bindings and triggers are part of the deployment.** A rollback that
   restores code but drops the D1 binding (`DB`), variables (`DOMAINS`,
   `MAIL_TTL_HOURS`), cron schedule, custom domain, or the Email Routing
   catch-all target has not rolled back — it has created a third,
   different broken state. Check all five after any rollback.

### 8.2 Procedure

**Option A — Dashboard / Wrangler version rollback (preferred when the
previous version is listed):**

1. Dashboard → Workers & Pages → `temp-mail` → **Deployments** — identify
   the last known-good deployment (by timestamp + deployment ID recorded
   in §8.1).
2. Roll back / redeploy that version (or `npx wrangler rollback` where
   supported by the installed Wrangler version).
3. Re-verify §8.4.

**Option B — Redeploy the previous artifact via Wrangler:**

```bash
# From a checkout of the last known-good source:
npx wrangler deploy
npx wrangler deployments list   # confirm the new (restored) deployment is active
```

**Option C — Redeploy via the Cloudflare API (the v1 method):**

- Re-upload the previous known-good module with its metadata (bindings,
  compatibility date) to
  `PUT /accounts/{account_id}/workers/scripts/temp-mail`, then re-apply
  the schedule (`PUT .../temp-mail/schedules`, hourly cron) — schedules
  and bindings supplied at upload time replace existing ones, so the
  metadata in the request must be complete, not minimal.
- Credentials for API deploys are **temporary and single-purpose**:
  create → deploy → verify → **delete the token** in the dashboard.
  v1 followed exactly this pattern (token created for the deploy and
  deleted afterwards, verified absent from the token list). Never leave
  a standing deploy token “for next time”, and never commit one.

**Email Routing during rollback:** the catch-all points at the Worker
**name** (`temp-mail`), not a version — a code rollback normally needs
no routing change. Touch Email Routing only if the rollback also
renames/replaces the Worker, and re-verify the catch-all afterwards
(enabled, action = Worker `temp-mail`, `me@turjaun.xyz` rule intact).

### 8.3 The “Hello World” incident — lesson (v1, 2026-11-21)

What happened in v1, kept here so v2 does not repeat it:

- The `temp-mail` Worker was **created** in the dashboard with the
  default “Hello World!” code. Variables, the D1 binding, and the cron
  trigger were all correctly configured around it.
- Every surface check that only looked at configuration passed — while
  `GET /api/health` returned the plain text `Hello World!` and every
  API route was effectively absent.
- The dashboard code editor could not accept the real code by paste, so
  the Worker stayed in the default state until the real module was
  uploaded **via the API**, after which `/api/health` returned
  `{"ok":true,...}`, address creation worked, handlers listed were
  `fetch`, `email`, `scheduled`, and only then could the catch-all be
  pointed at the Worker (Cloudflare only lists Workers exporting an
  email handler as Email Routing targets).

**Standing rules derived from it:**

- “Deployed” means: live `/api/health` returns `ok:true` **and** a
  create-address call succeeds **and** the deployment's handlers include
  `email`. Nothing less.
- A `200` from an uptime checker without the body assertion (§6.1) is a
  false green — exactly the failure this incident produced.
- If a deploy path (editor paste, CI step, script) cannot be verified
  end-to-end, switch paths (API/Wrangler) instead of retrying the broken
  path and reporting progress.

### 8.4 Post-rollback verification (all required)

```bash
curl -s https://mail.turjaun.xyz/api/health
# {"ok":true,...}
curl -s https://temp-mail.turjaun.workers.dev/api/health
# {"ok":true,...}

curl -s -X POST https://mail.turjaun.xyz/api/new_address \
  -H "Content-Type: application/json" \
  -d '{"name":"rollback-test","domain":"turjaun.xyz"}'
# returns an address + token, no 5xx
```

- [ ] Health `ok:true` on both hostnames
- [ ] Create-address succeeds; inbox list for the new token succeeds
- [ ] Worker handlers include `email`; cron trigger present (§4.2.1)
- [ ] D1 binding resolves (no binding errors in logs, §5)
- [ ] Catch-all still enabled → Worker `temp-mail`; `me@` rule intact
- [ ] End-to-end mail test sent and received (or explicitly scheduled
      and recorded as pending — not silently skipped)
- [ ] Incident/rollback record filed (§5.3) including the bad and good
      deployment IDs

---

## 9. Go-live checklist — `turjaun.xyz`

Status key: **Done** = verified live in v1 / carried forward as fact.
**Todo** = not yet verified for v2 production; owner/agent must complete
and evidence it. Do not flip a Todo to Done on intention.

| # | Item | Status | Evidence / notes |
|---|---|---|---|
| 1 | Domain on Cloudflare, zone active | ✅ Done | Nameservers `kenia` / `renan.ns.cloudflare.com` |
| 2 | Email Routing enabled, MX → `route1/2/3.mx.cloudflare.net`, SPF present | ✅ Done | Verified by DNS lookup in v1 |
| 3 | D1 `temp-mail-db` created, `addresses` + `mails` schema + indexes applied | ✅ Done | Verified in D1 Console in v1 (tables listed) |
| 4 | Worker `temp-mail` deployed with real code (not default) | ✅ Done (v1) / re-verify for v2 | v1: `/api/health` → `ok:true`, handlers `fetch`/`email`/`scheduled`. **Every v2 deploy re-opens this row until §8.4 passes** |
| 5 | Variables set: `DOMAINS=turjaun.xyz`, `MAIL_TTL_HOURS=24` | ✅ Done (v1) | Set in dashboard + deploy metadata in v1; confirm deployed values for v2 (§4.2) |
| 6 | D1 binding `DB` → `temp-mail-db` on the Worker | ✅ Done (v1) | Re-check after any API/Wrangler deploy (§8.1.3) |
| 7 | Hourly cleanup cron `0 * * * *` attached | ✅ Done (v1) | Trigger + schedule verified in v1; deletion behaviour re-verified per §4.2 for v2 |
| 8 | Catch-all enabled → Worker `temp-mail` | ✅ Done | Set via API in v1 and verified (`enabled:true`, action `worker:["temp-mail"]`) |
| 9 | `me@turjaun.xyz` personal forwarding rule preserved | ✅ Done | Untouched through v1 deploy and catch-all change; re-check after any routing edit |
| 10 | API create-address + inbox read verified live | ✅ Done (v1) | `test123@turjaun.xyz` created; empty-inbox read returned correctly in v1 |
| 11 | End-to-end inbound mail (Gmail → inbox → OTP extraction) | ⏳ Todo | Owner send test was the pending v1 step; record the dated, observed result for v2 go-live — do not mark Done from API tests alone |
| 12 | Temporary deploy API token deleted after use | ✅ Done (v1) | Created for the v1 API deploy, deleted in dashboard, verified absent from token list |
| 13 | Custom domain `mail.turjaun.xyz` attached, cert Active, health `ok:true` on it | ⏳ Todo | §1 — production hostname cutover |
| 14 | Rate-limit rules R1–R5 created and smoke-tested | ⏳ Todo | §2.1 + §2.3 — record observed 429/403 evidence |
| 15 | WAF rules W1–W2 created (Log → Block after review) | ⏳ Todo | §2.2 |
| 16 | Bot Fight Mode posture decided and API re-tested after the decision | ⏳ Todo | §3 — JSON (not challenge HTML) from API clients is the pass condition |
| 17 | External uptime monitor on `/api/health` with body assertion `"ok":true` | ⏳ Todo | §6.1 — bare-200 monitors do not count |
| 18 | Second health monitor on `workers.dev` URL (divergence detection) | ⏳ Todo | §6.1 |
| 19 | Workers Logs / observability enabled and reviewed once | ⏳ Todo | §5.2 |
| 20 | First weekly D1 check recorded (size, row counts, expired-row query) | ⏳ Todo | §4.1 / §4.3 — establishes the growth baseline |
| 21 | Rollback rehearsal: previous deployment identified and §8.4 checklist dry-run | ⏳ Todo | §8 — a rollback plan that has never been located in the dashboard is a hypothesis |
| 22 | v2 performance baseline measured per route (duration/CPU for inbox reads vs health) | ⏳ Todo | §5.2 — required justification for any Rust/Wasm or polling optimisation claiming a speedup |
| 23 | Docs updated to production hostname (`AGENTS.md`, API docs, README examples) | ⏳ Todo | After #13 only; keep `workers.dev` as documented fallback |
| 24 | Upgrade triggers reviewed against current free-tier quotas | ⏳ Todo | §7 — re-verify quota numbers on the plan page and date the check |

### Sign-off rule

Go-live is declared only when:

- every **Todo** above is either Done **with evidence** or explicitly
  accepted as a known gap by the owner, by name and date, in the change
  log; and
- §8.4 passes on the final deployment; and
- one real inbound email has been observed end-to-end (#11).

Anything less is “deployed to production-like”, not production — the
distinction the Hello World incident exists to teach.

---

*End of production checklist. Companion docs: `docs/API.md` (endpoints),
architecture notes in `docs/ARCHITECTURE.md`, and agent operating
instructions in `AGENTS.md`.*
