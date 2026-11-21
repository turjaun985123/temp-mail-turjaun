# SECURITY.md — Temp Mail v2 Security Review

**Service:** Temp Mail v2 — `https://temp-mail.turjaun.workers.dev`, domain `turjaun.xyz`
**Scope reviewed:** `src/worker-v2.js`, `ui/app.js`, `src/rate-limit.js`,
`src/webhooks.js`, `wrangler.toml`, `scripts/deploy-api.py`, `AGENTS.md`
**Method:** manual code audit of the files above. Every finding cites the
code it rests on. Nothing in this review is a claim about code that was not
read; where a module is well designed but not actually used, the finding
says exactly that.
**Posture in one line:** this is a *public* disposable-mail service. Its
core design — anyone can create an inbox, and mail is inherently
low-confidentiality — is intentional. The serious findings below are not
"temp mail exists"; they are places where the *per-inbox token*, the one
real access control the design has, is bypassed by other endpoints.

---

## 1. Threat model

### 1.1 Assets

| Asset | Why it matters |
|---|---|
| Mail bodies in D1 (`mails.text_body` / `html_body`) | Routinely contain OTPs and one-time verification / password-reset links — i.e. credentials for *other* services |
| Per-inbox Bearer tokens (`addresses.token`) | Sole credential separating one inbox from another on the authenticated endpoints |
| Inbox addresses themselves | On one endpoint family (see SEC-01) the address *is* the credential |
| Worker availability / D1 quota | `/api/wait` holds requests open ~25 s and polls D1; unbounded use is a cost/availability risk on the free tier |
| `WEBHOOK_SECRET`, Cloudflare deploy/API tokens | Compromise = forged webhook deliveries, or full Worker/D1 control |
| The `turjaun.xyz` domain's reputation | A public catch-all that can receive (and be used to sign up with) mail at any address |

### 1.2 Actors

- **Legitimate user / agent** — creates one inbox, waits, reads its OTP
  (the flow in `AGENTS.md`).
- **Curious third party** — knows or guesses an address that someone else
  used for a signup (addresses are often predictable: chosen names,
  `test123@…`, a name visible in a screenshot or a shared link).
- **Abusive third party** — farms inboxes in bulk, enumerates message IDs,
  deletes other people's mail, stacks long-polls, or uses disposable
  addresses to evade another service's signup controls.
- **Mail sender (fully untrusted)** — anyone on the internet can send mail
  to any `@turjaun.xyz` address. Subject, body and HTML are
  attacker-controlled content that the API stores and the UI displays.
- **Operator** — owns the Cloudflare account, sets `WEBHOOK_URL` /
  `WEBHOOK_SECRET` and deploy tokens. Trusted by definition; several
  controls below exist to keep operator *mistakes* from becoming holes.

### 1.3 Trust boundaries

```
Internet sender ──mail──▶ Cloudflare Email Routing ──▶ email() handler
                                                        │ parseRaw()
                                                        ▼
Browser / agent ──HTTPS──▶ fetch() router ──bound SQL──▶ D1 (addresses, mails)
                                │
                                └──ctx.waitUntil──▶ deliverWebhook() ──▶ operator's WEBHOOK_URL
```

- All SQL crosses the Worker→D1 boundary as bound parameters (SEC-05).
- All mail content crosses the API→browser boundary and must be treated as
  untrusted markup (SEC-06).
- The webhook URL must only ever cross from operator config, never from
  mail or API input (SEC-10).

### 1.4 The address-as-capability design (read this before the findings)

Two different access models coexist in `worker-v2.js`:

1. **Token model** — `GET /api/mails` correctly requires
   `Authorization: Bearer <token>` and resolves the token to exactly one
   address server-side.
2. **Address-as-capability model** — `GET /api/inboxes/:address/messages`
   requires *no* token at all: knowing the address is sufficient to read
   the full bodies. This is a v1 compatibility behaviour, and `AGENTS.md`
   §4 marks the endpoint "Yes\*" for auth — but the code does not check
   anything. In practice this means **the token model is only as strong as
   address secrecy, and addresses are not secrets**: users pick readable
   names, addresses are sent to third-party services (which is the whole
   point), and they appear in the `From`/`To` headers of ordinary mail.

SEC-01…SEC-04 are all consequences of model 2 and of two endpoints that
implement neither model. They are reported separately because each needs
its own fix, but they should be understood — and fixed — together.

---

## 2. Findings summary

| ID | Area | Severity | Status |
|---|---|---|---|
| SEC-01 | `/api/inboxes/:address/messages` — unauthenticated full-mail read | **High** | Open (by-design in v1, not yet fixed in v2) |
| SEC-02 | `/api/mail/:id` — unauthenticated read **and delete** by enumerable ID | **High** | Open |
| SEC-03 | Token of an existing named inbox returned to any unauthenticated caller | **High** | Open |
| SEC-04 | `/api/wait` address fallback + token-in-query-string | Medium | Open |
| SEC-05 | SQL injection | — (pass) | No vulnerability found |
| SEC-06 | XSS / mail HTML handling in UI | Low (residual) | Mitigated in `ui/app.js`; contract risk for other API consumers |
| SEC-07 | Token entropy (pass) / plaintext token storage (fail) | Medium | Open (storage) |
| SEC-08 | CORS `*` on all endpoints | Low | Accepted / revisit if API goes private |
| SEC-09 | Rate limiting module exists but is **not wired into the Worker** | Medium–High | Open (integration pending) |
| SEC-10 | Webhooks: HMAC design sound, module **not wired in**; residual SSRF notes | Medium | Open (integration + secret enforcement) |
| SEC-11 | Secrets handling (wrangler, deploy script, deploy tokens) | — (pass) | No vulnerability found |
| SEC-12 | D1 data retention vs the 24 h promise | Low | Mostly honoured; one orphan-row gap |
| SEC-13 | Abuse: signup/spam abuse of a public disposable service | Medium | Accepted risk — operator responsibility, see disclaimer |
| SEC-14 | Missing security response headers on the UI | Low | Open (trivial fix) |
| SEC-15 | Long-poll resource use (D1 polling loop, no concurrency cap) | Medium | Open (depends on SEC-09) |
| SEC-16 | Inbound mail size / parser truncation order | Low | Accepted (platform limits apply) |
| SEC-17 | Weak ETag hash (FNV-1a) on authenticated list responses | Info | Accepted |

---

## 3. Findings in detail

### SEC-01 — Unauthenticated read of any inbox by address — **High — Open**

**Evidence** (`src/worker-v2.js`, `/api/inboxes/:address/messages` handler):
the handler decodes the address from the path and queries
`mailsQuery(address, …)` with columns including `text_body, html_body`,
then returns `enrichMail(r, true)` — full bodies plus extracted `otp` and
`verification_links`. There is no token lookup anywhere in the handler
(contrast `/api/mails`, which does `SELECT address FROM addresses WHERE
token=?` and returns 401 without a match).

**Impact:** anyone who knows or guesses `victim@turjaun.xyz` can read that
inbox's OTPs and click-equivalent verification links, in real time, with a
single `curl`. Guessing is realistic for chosen names; random 10-character
addresses are not practically guessable, which is the only thing limiting
this today.

**Fix:** require the inbox token on this endpoint and check it resolves to
the requested address (same pattern as `/api/mails`). If a capability-style
URL is genuinely wanted for integrations, make it a *separate, unguessable*
capability (e.g. the token itself in the path for a dedicated feed route),
never the address. Update `AGENTS.md` §4 so doc and code agree.

### SEC-02 — Unauthenticated read and delete of any single mail by ID — **High — Open**

**Evidence** (`src/worker-v2.js`, `mailMatch` block):

```js
if (mailMatch && request.method === "GET") {
  const row = await env.DB.prepare("SELECT * FROM mails WHERE id=?")…
}
if (mailMatch && request.method === "DELETE") {
  await env.DB.prepare("DELETE FROM mails WHERE id=?")…
}
```

Neither branch reads the `Authorization` header. IDs are D1
`AUTOINCREMENT` integers — sequential and enumerable from any mail the
attacker legitimately receives in their own inbox.

**Impact:** read any stored mail (any inbox) by incrementing an integer;
**delete** any stored mail the same way — e.g. delete a victim's OTP mail
before they read it. This directly contradicts `AGENTS.md` §3/§4, which
list `DELETE /api/mail/<id>` as auth-required and `GET /api/mail/:id` as
auth "Yes\*". The documentation is right; the code does not do it.

**Fix:** in both branches, resolve the Bearer token to an address first
and constrain the statement:
`… WHERE id=? AND address=?` (and return 404, not 401/403, on mismatch so
existence is not confirmed cross-inbox).

### SEC-03 — Existing inbox's token disclosed on "reused" create — **High — Open**

**Evidence** (`src/worker-v2.js`, `POST /api/new_address`):

```js
catch (e) {
  if (String(e).includes("UNIQUE")) {
    const row = await …("SELECT token FROM addresses WHERE address=?")…
    return jsonNoStore({ address, token: row?.token, reused: true });
  }
```

`POST /api/new_address` is unauthenticated (by design — it is how inboxes
are created). So for any *named* address that already exists, any caller
can retrieve that inbox's live Bearer token by simply "creating" the same
name. That silently converts the token model into the address model for
every non-random address, and makes SEC-01's fix moot for named inboxes
unless this is fixed too. `AGENTS.md` §4 documents the `reused:true`
response as a success case without noting the credential disclosure.

**Fix:** never return a token you did not just generate. On name collision
return `{ address, reused: true }` *without* the token (the legitimate
owner still has theirs), or require the existing token in the request to
reclaim an address. Expect a behaviour change for agents that rely on
re-creating to recover a lost token — that reliance is the vulnerability.

### SEC-04 — `/api/wait`: address-only fallback and query-string tokens — **Medium — Open**

**Evidence** (`resolveAddress()` in `src/worker-v2.js`): if no token is
present, the function falls back to `url.searchParams.get("address")` and
returns it as the authorised address. `/api/wait` therefore long-polls any
address for anyone (same disclosure class as SEC-01, plus the resource
cost in SEC-15). Separately, both `resolveAddress()` and `/api/mails`
accept the token as `?token=` — query-string credentials leak into access
logs, browser history, proxy logs and `Referer` headers in a way the
`Authorization` header does not.

**Fix:** `/api/wait` should accept only the Bearer-token path (delete the
address fallback). Deprecate `?token=`; if it must stay for a client,
document it as leak-prone and prefer the header in all examples
(`AGENTS.md` already teaches the header — the server should match).

### SEC-05 — SQL injection — **Pass, no vulnerability found**

**Audit:** every `env.DB.prepare(...)` call in `src/worker-v2.js` was
checked (address/token lookups, address insert, the `/api/wait` select,
both paged list queries, single-mail select/delete, the `email()` inserts,
and both `scheduled()` deletes). **All user-influenced values are passed
via `.bind(...)` — no string interpolation of request, address, token, or
mail data into SQL anywhere.**

The one place SQL is assembled dynamically is `mailsQuery(address, pg,
columns)`: it concatenates a fixed skeleton plus a `columns` fragment.
Both call sites pass hard-coded column-list literals from inside this
file; `limit`/`offset`/`since_id`/`before_id` reach the query only after
`parsePagination()` / `intParam()` have run them through `parseInt` and
clamping (`limit` 1–50, offsets ≥ 0), and they are *still* bound, not
interpolated.

**Residual note (not a vuln):** `mailsQuery`'s `columns` parameter would
become an injection sink if a future caller ever passed request data to
it. Keep the rule "call-site literals only" — it is already stated in the
function's own comment; do not relax it.

### SEC-06 — XSS and mail HTML handling — **Low residual — Mitigated in the shipped UI**

Mail HTML/body is attacker-controlled (§1.2). Review of `ui/app.js`:

- **List rendering is DOM-API only.** `buildMailNode()` sets subject,
  sender, time and preview with `textContent` — mail data is never parsed
  as HTML in the list.
- **Detail rendering escapes first.** `highlightedBody()` runs the full
  `esc()` escape (`& < > " '`) over `text_body` *before* the single
  `innerHTML` assignment in `viewMail()`, and the only markup inserted
  afterwards is `<mark>…</mark>` wrapped around a digits-only OTP string.
  The comment in the code makes the same argument; it is correct —
  escaping first means mail content cannot re-introduce tags.
- **`html_body` is never rendered.** `ui/app.js` does not reference
  `html_body` at all; there is no sanitizer (no DOMPurify) because no
  code path needs one. That is the right call for this UI.

**Residual risks, stated honestly:**

1. **API consumers are on their own.** The API returns raw `html_body`.
   Any *other* client that injects it into a page without sanitisation
   has stored XSS from any mail sender. The API documentation should say
   in so many words: treat `html_body` as hostile, render `text_body`, or
   sanitize with a real sanitizer before display. This review does not
   invent a vuln in this repo for that — it is a contract warning.
2. **Inline fallback UI in `worker-v2.js` (`UI_HTML`)** uses two
   `innerHTML` concatenations: the domain `<option>`s (values come from
   operator config `DOMAINS`, trusted) and `'No mails yet — send to ' + A`
   where `A` is the current address. Address local-parts are sanitised
   server-side to `[a-z0-9._-]` on create, which excludes markup
   characters, so this is not exploitable as shipped — but it is the
   fragile pattern `ui/app.js` deliberately avoided. Prefer `textContent`
   there too when the inline UI is next touched.
3. Tokens live in `localStorage` (`tm_v2_token` in `ui/app.js`, `t` in the
   inline UI). Any future XSS on the origin would therefore be token
   theft, not just defacement — one more reason the escape discipline
   above must not regress.

### SEC-07 — Auth tokens: strong entropy, plaintext storage — **Medium — Open (storage half)**

**Entropy — pass.** `token()` in `worker-v2.js` draws 32 bytes from
`crypto.getRandomValues()` and hex-encodes them: 256 bits, CSPRNG, no
predictability concern. (The *address* generator `rnd()` uses the same
CSPRNG with a modulo reduction over a 36-symbol alphabet — a negligible
bias, and addresses are identifiers, not secrets, token-model endpoints
aside.) Tokens are compared by D1 equality lookup, not by hand-rolled
string comparison, so there is no timing side channel of consequence.

**Storage — fail.**
- Tokens are stored **in plaintext** in `addresses.token`. Anyone who
  obtains the D1 contents (export, backup, a future SQL bug, an
  over-privileged token) obtains every live inbox credential. Standard
  practice for a bearer credential like this is to store a SHA-256 hash
  and look up by hash — cheap here because lookup is already by exact
  token value.
- The token is displayed in the UI and persisted in `localStorage`
  (SEC-06.3) with no expiry of its own; it dies only with the address row
  (24 h TTL, SEC-12) or not at all for the orphan rows in SEC-12.
- Naming: the create response returns the same opaque value as both
  `token` and `jwt`. It is **not** a JWT — nothing signs or verifies it.
  The alias is v1 compatibility, but it invites a future maintainer to
  assume signature properties it does not have. Document it as an opaque
  bearer token everywhere except the wire field name.

**Fix:** hash-at-rest (store `SHA-256(token)`, bind the hash in lookups),
keep returning the plaintext exactly once at creation — which pairs
naturally with the SEC-03 fix.

### SEC-08 — CORS — **Low — Accepted, revisit on any move to private use**

**Evidence:** `CORS` in `worker-v2.js` is
`Access-Control-Allow-Origin: *` with `Authorization` in
`Access-Control-Allow-Headers`, applied to every response including
`OPTIONS` handling and error/429 responses in `rate-limit.js`.

**Assessment:** for a deliberately public, cookie-less API this is not a
vulnerability by itself: no ambient credentials exist for a cross-origin
site to ride on (no cookies are set or read), and a cross-origin page
still needs the victim's token to call authenticated endpoints — it
cannot read the token from `localStorage` on this origin. What `*` *does*
do is remove the browser as a line of defence-in-depth: any website can
drive the full API (including inbox creation) from a visitor's browser
with that visitor's IP as the rate-limit key. Combined with SEC-09 (no
enforced limits), that is an abuse amplifier, not a data leak.

**Fix (when warranted):** if a first-party UI origin is fixed, allowlist
it for the UI's calls and leave `*` only on the documented public API
surface — or accept `*` explicitly as a product decision. Do not add
`Access-Control-Allow-Credentials` in either case.

### SEC-09 — Rate limiting: good module, **not integrated** — **Medium–High — Open**

**Evidence:** `src/rate-limit.js` exports `createRateLimiter`,
`getClientKey`, `rateLimitResponse` and `RECOMMENDED_LIMITS`.
`src/worker-v2.js` contains **no import of it** (the Worker file has no
imports at all) and no call to any limiter. As shipped, the Worker
enforces **no application-level rate limit on any endpoint.**

**What the module would give, once wired** (from `RECOMMENDED_LIMITS`):

| Limiter | Limit | Key |
|---|---|---|
| `createInbox` | 10 / min | client IP (`CF-Connecting-IP` via `getClientKey`) |
| `mailsRead` | 60 / min | inbox token |
| `wait` | 6 / min **and** max 1 concurrent | inbox token |

**Honest limits of the module itself** (its own header says this, and the
review agrees): counters are an in-memory `Map` per Worker isolate.
Cloudflare runs many isolates across PoPs and recycles them, so the
effective global limit is roughly *max × live isolates*, and counts reset
on recycle/deploy. It is a brake on naive abuse and D1 pressure, **not** a
security boundary. The module documents the correct upgrade path
(Durable Object per key, or Cloudflare's native rate-limit binding) and
correctly recommends zone WAF Rate Limiting Rules for
`/api/new_address` as the layer that actually holds.

**Impact while unwired:** unlimited inbox farming from one IP, unlimited
reads, and — worst — unlimited concurrent `/api/wait` (SEC-15). Fix is
integration, not new code: import the module, instantiate limiters once
at module scope, check at the three call sites exactly as the module's
header example shows, and add the WAF rule for `POST /api/new_address`.

### SEC-10 — Webhooks: sound HMAC design, **not integrated**; residual SSRF notes — **Medium — Open**

**Evidence:** `src/webhooks.js` exports `deliverWebhook`,
`signPayload`, `validateWebhookUrl`. Like SEC-09, **nothing in
`worker-v2.js` imports it** — the deployed `email()` handler inserts the
mail and returns; no webhook fires today. The review below is therefore
of the module's design, ready for integration, not of live behaviour.

**What the design gets right:**
- **SSRF posture:** the destination comes *only* from the server-side
  `WEBHOOK_URL` env var — never from mail content, headers, or API input.
  An attacker who can send mail cannot choose the destination. This is
  the single most important SSRF control for a webhook feature, and it
  is in place.
- **Scheme:** `validateWebhookUrl()` accepts only `https:` — a
  downgraded or misconfigured URL fails closed, so mail (including OTPs,
  which the payload deliberately carries) is never POSTed in plaintext.
- **HMAC:** `signPayload()` is HMAC-SHA256 (WebCrypto) over the *exact*
  serialized body bytes that are then sent; the header is
  `X-TempMail-Signature` (hex). The secret itself is never placed in the
  body, the headers (other than its HMAC), or any log line in the module
  — failure logs carry only address + status / error name.
- **Availability:** single attempt, 5 s `AbortController` timeout,
  never throws, intended for `ctx.waitUntil(...)` — a bad receiver cannot
  hang or fail mail ingestion, and there is no retry storm.

**Residual issues to fix at integration:**
1. **Unsigned-by-default.** If `WEBHOOK_SECRET` is unset, `signPayload`
   returns `""` and delivery proceeds *unsigned*. For a payload containing
   OTPs that is fail-open. Make production delivery require the secret
   (refuse to deliver, loudly, when a URL is set but no secret is), or at
   minimum surface the module's own "set it in production" note as a
   deploy checklist item that is actually checked.
2. **Private/loopback destinations not rejected.** `validateWebhookUrl`
   checks the scheme only; an `https://` URL pointing at a loopback,
   link-local, or otherwise internal host passes. Because the URL is
   operator-supplied (trusted input), this is a *misconfiguration /
   defence-in-depth* gap, not an attacker-controlled SSRF — but a
   blocklist for loopback/private literal IPs and hostnames costs little.
   Note also that `fetch` follows redirects by default, so an allowed
   public URL can still redirect toward `http:` or an internal target;
   consider `redirect: "manual"` / rejecting 3xx at delivery.
3. **Replay is the receiver's job.** The module correctly documents that
   receivers must compare the HMAC in constant time and reject stale
   `created_at` payloads — there is no timestamp/nonce *inside* the
   signed envelope beyond `mail.created_at`. Keep that receiver guidance
   wherever the webhook is documented for consumers.

### SEC-11 — Secrets handling — **Pass, no vulnerability found**

- **`wrangler.toml`** contains no secret values — only the non-secret
  `DOMAINS` and `MAIL_TTL_HOURS` vars and the (public) D1 database ID.
  Its header instructs `wrangler secret put` for real secrets and warns
  that `.dev.vars` must never be committed. The Worker code contains no
  hard-coded secrets either.
- **`scripts/deploy-api.py`** reads the Cloudflare API token *only* from
  the `CLOUDFLARE_API_TOKEN` environment variable, fails closed when it
  is missing (outside `--dry-run`), uses it only in the `Authorization`
  header, and never prints it.
- **Deploy-token practice (v1 deployment):** the one-off deploy was done
  with a temporary, narrowly scoped API token (Workers Scripts Edit,
  D1 Edit, Workers Routes / Email Routing Rules Edit, Zone Read — one
  account, one zone) that was **deleted in the dashboard after the deploy
  was verified**, and the deletion was confirmed against the token list.
  That is the pattern to repeat: scoped, short-lived, revoked — never a
  long-lived global token for deploys, and never a token value in chat,
  code, commits, or this document.
- **Webhook secret:** see SEC-10 — sourced from env only, never logged
  by the module.

### SEC-12 — D1 data retention vs the 24-hour promise — **Low — Mostly honoured, one gap**

**What works:** the `scheduled()` handler runs hourly (cron
`0 * * * *` in `wrangler.toml`) and deletes
`mails WHERE created_at < now − MAIL_TTL_HOURS` (default 24 h) and
addresses whose `expires_at` has passed. Created inboxes get
`expires_at = now + 24 h`. Mail content therefore does not accumulate
indefinitely, which bounds the blast radius of SEC-01/02 to roughly a
day's mail.

**Gaps, honestly stated:**
1. **Orphan address rows never expire.** The `email()` handler
   auto-creates an `addresses` row for *any* recipient (catch-all) with
   `INSERT … (address, token)` and **no `expires_at`** — and the cleanup
   query is `… WHERE expires_at IS NOT NULL AND expires_at < ?`, so those
   rows (and their plaintext tokens, SEC-07) persist forever. Their mail
   is still deleted on schedule; the rows themselves are a small,
   ever-growing list of addresses that ever received mail. Fix: give
   auto-created rows an `expires_at` too, or delete address rows with no
   remaining mail and no expiry.
2. **Deletion is hourly, not exact** — mail can live up to ~1 h past the
   24 h mark between cron runs. Within the spirit of the promise;
   documented here so nobody claims otherwise.
3. **Platform retention is out of the Worker's control.** D1 backups /
   point-in-time recovery operated by Cloudflare may retain deleted rows
   for the platform's own window. The 24 h promise is about the live
   tables; do not market it as cryptographic erasure.

### SEC-13 — Abuse disclaimer: a public disposable inbox *will* be abused — **Medium — Accepted risk**

No code finding here — a product fact the operator must own:

- Unauthenticated creation + a catch-all on a real domain is, by
  construction, usable for throwaway signups, ban evasion, and one-time
  interactions the receiving services did not intend to allow. `AGENTS.md`
  §6.8 and §8 restrict *its own documented use* to legitimate signups and
  testing; that binds cooperating agents, not the internet.
- The domain can also *receive* abuse: spam and phishing sent to arbitrary
  `@turjaun.xyz` addresses lands in D1 (bounded by SEC-12 retention and
  the parser's 50 000-char per-part truncation, SEC-16), and bulk inbound
  mail is a D1-quota cost even when nobody reads it.
- Practical operator mitigations, in order of leverage: wire the rate
  limiter (SEC-09) **and** a zone WAF rate-limit rule on
  `POST /api/new_address`; consider a challenge (e.g. Turnstile) on the
  web UI's create flow if farming becomes real; monitor D1 size and mail
  volume; be ready to disable the catch-all (Email Routing → catch-all →
  off) as the kill switch — knowing it also stops legitimate inboxes.
- Do not use this service for accounts whose compromise you would
  actually mind. An OTP delivered here is protected, today, by address
  secrecy on some endpoints (SEC-01) — treat temp-mail OTPs as
  low-assurance by design.

### SEC-14 — Missing security response headers — **Low — Open**

**Evidence:** the `/` response in `worker-v2.js` sets only
`Content-Type` and `Cache-Control`; no `Content-Security-Policy`,
`X-Content-Type-Options`, `Referrer-Policy`, or frame protection appears
anywhere in `src/` or `ui/`. The UI is first-party and (per SEC-06)
careful with `innerHTML`, so this is hardening, not an active hole — but
a restrictive CSP (e.g. `default-src 'self'` with the inline-script needs
of the fallback UI handled explicitly) is cheap insurance for exactly the
token-in-`localStorage` situation in SEC-06.3, and `nosniff` removes a
class of content-type confusion for API responses.

### SEC-15 — Long-poll resource use — **Medium — Open (depends on SEC-09)**

**Evidence:** `/api/wait` loops for up to 25 s, querying D1 every
1 200 ms (`pollMs`), per request. There is no concurrency cap in the
Worker, and the `wait` limiter that would impose "6/min and at most 1
concurrent per token" (`RECOMMENDED_LIMITS.wait`) is not wired (SEC-09).
Via the SEC-04 address fallback, these held-open, D1-polling requests do
not even require a token. A modest number of parallel waits — accidental
(a buggy client stacking polls, which `AGENTS.md` §6 forbids but the
server does not enforce) or deliberate — translates directly into Worker
duration and D1 read volume. **Fix:** SEC-09 integration, server-side
enforcement of one outstanding wait per inbox, and the SEC-04 fix.

### SEC-16 — Inbound mail size / parser order — **Low — Accepted**

**Evidence:** `email()` reads the entire raw message into a string
(`new Response(message.raw).text()`) *before* `parseRaw()` truncates
`text`/`html` to 50 000 chars each. Truncation therefore bounds *storage*,
not *parsing memory*. In practice Cloudflare Email Routing enforces its
own inbound message-size limits before the handler runs, and the parser
is a single-pass string scanner with no backtracking regexes over body
content — so this is recorded as a known characteristic, not a defect.
Revisit only if the parser changes (e.g. the planned Rust/WASM swap at
the `RUST_WASM_HOOK` point must keep the same truncation contract).

### SEC-17 — ETag hashing on list responses — **Info — Accepted**

`listJson()` builds ETags with FNV-1a, a fast **non-cryptographic** hash,
and serves the lists with `Cache-Control: private, max-age=2`. FNV-1a
collisions are easy to construct, but the ETag is only compared against
the *same client's* `If-None-Match` for a 304 optimisation — a collision
can make a client keep its own stale copy for one 2-second window; it
cannot cross inboxes (the underlying query is still token/address
scoped) and `private` keeps shared caches out. No change required;
recorded so a future reader does not mistake the ETag for an integrity
or authorisation mechanism.

---

## 4. What was checked and found clean

- **SQL injection** — full `.prepare()` audit, all values bound (SEC-05).
- **Token generation** — 256-bit CSPRNG bearer tokens (SEC-07, entropy).
- **UI XSS discipline** — `textContent` list rendering, escape-then-mark
  detail rendering, `html_body` never rendered (SEC-06).
- **Webhook destination control & HMAC construction** — operator-only
  URL, https-only, HMAC over exact bytes, secret never logged (SEC-10).
- **Repository / deploy secrets** — no secret values in `wrangler.toml`
  or code; deploy token env-only in the script, scoped and revoked in
  practice (SEC-11).
- **Input shaping on create** — domain checked against the `DOMAINS`
  allowlist, local-part lower-cased and stripped to `[a-z0-9._-]`,
  empty-after-sanitise rejected with 400 (`POST /api/new_address`).
- **Pagination shaping** — `limit` clamped 1–50, offsets floored at 0,
  cursor IDs `parseInt`-validated before use (`parsePagination`).
- **Mutation caching** — creates/deletes and `/api/wait` return
  `Cache-Control: no-store` (`jsonNoStore`); the 429 builder in
  `rate-limit.js` does the same.

## 5. Fix priority, in order

1. **SEC-02** — auth + ownership check on `GET`/`DELETE /api/mail/:id`
   (smallest change, closes unauthenticated *deletion*).
2. **SEC-03** — stop returning existing tokens from `POST /api/new_address`.
3. **SEC-01 + SEC-04** — require the inbox token on
   `/api/inboxes/:address/messages` and `/api/wait`; drop `?token=` and
   the `?address=` fallback.
4. **SEC-09 + SEC-15** — import `rate-limit.js`, wire the three limiters,
   enforce one concurrent wait per inbox, add the WAF rule on
   `POST /api/new_address`.
5. **SEC-07** — store token hashes, not tokens.
6. **SEC-10** — wire `webhooks.js` only with `WEBHOOK_SECRET` mandatory,
   and add the private/loopback + redirect handling.
7. **SEC-12** — expiry for auto-created address rows.
8. **SEC-14, SEC-08** — security headers; CORS decision recorded.

*End of review. Severities assume the service stays public and keeps
receiving real OTP mail; if either stops being true, re-triage SEC-01…04
first — in a private deployment they would be Critical, not High.*
