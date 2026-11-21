// ---------------------------------------------------------------------------
// rate-limit.js — Temp Mail v2 rate limiting (zero dependencies, ESM)
//
// WHAT THIS IS
//   A tiny fixed-window rate limiter for worker-v2.js: createRateLimiter(),
//   getClientKey(), rateLimitResponse(), and RECOMMENDED_LIMITS. No imports,
//   no bindings, no storage — it runs anywhere the Worker runs.
//
// ⚠️  READ THIS FIRST — IN-MEMORY LIMITS ARE PER-ISOLATE AND BEST-EFFORT ONLY
//   The counters live in a module-level `Map` inside one Worker isolate.
//   Cloudflare Workers does NOT give you one global isolate:
//     * Requests are spread across many isolates, in many data centres
//       (PoPs), and a new isolate can be spun up — or an idle one evicted —
//       at any time. Each isolate has its OWN Map and its OWN counts.
//     * So the effective global limit is roughly `max × (live isolates that
//       happen to serve that key)`, counts reset whenever an isolate is
//       recycled, and nothing here survives a deploy.
//   That is fine for what this module is for — slowing down naive abuse,
//   signup/inbox spam bursts and runaway polling loops, and taking pressure
//   off D1 — and it fails OPEN in the user's favour rather than locking
//   legitimate users out. It is NOT a security boundary, NOT billing-grade
//   metering, and NOT a substitute for Cloudflare WAF Rate Limiting Rules
//   on the zone (use those too for /api/new_address if abuse becomes real).
//
// UPGRADE PATH — DURABLE OBJECTS (strict, global, per-key limits)
//   When a limit must actually hold globally, move the counter behind a
//   Durable Object and keep this module's call sites / result shape:
//     1. Add a `RateLimiterDO` class (its own module) whose single instance
//        per key owns the count: `idFromName(key)` gives one DO per IP /
//        per token, DO storage is strongly consistent and single-threaded,
//        so increment-and-check is atomic — no cross-isolate drift.
//     2. Bind it in wrangler.toml:
//          [[durable_objects.bindings]]
//          name = "RATE_LIMITER"
//          class_name = "RateLimiterDO"
//        plus the matching `[[migrations]]` tag for the DO class.
//     3. Replace the body of check() with:
//          const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
//          return stub.check({ windowMs, max });  // -> same {allowed, ...}
//        Call sites in worker-v2.js do not change.
//     4. Use a DO alarm / stored `resetAt` for window expiry instead of the
//        in-memory sweep below. For one global (not per-key) bucket, use a
//        single fixed DO name instead of idFromName(key).
//   (Cloudflare's native Rate Limiting binding — `env.MY_LIMITER.limit()` —
//   is the other managed option; it is also per-PoP by design, so pick the
//   DO route when the limit must be exact.)
//
// INTEGRATION EXAMPLE — worker-v2.js
//   // At the top of src/worker-v2.js:
//   import {
//     createRateLimiter, getClientKey, rateLimitResponse, RECOMMENDED_LIMITS,
//   } from "./rate-limit.js";
//
//   // One limiter per endpoint, created once at module scope (so the Map
//   // lives as long as the isolate does — do NOT create these per-request):
//   const createInboxLimiter = createRateLimiter(RECOMMENDED_LIMITS.createInbox);
//   const mailsReadLimiter   = createRateLimiter(RECOMMENDED_LIMITS.mailsRead);
//   const waitLimiter        = createRateLimiter(RECOMMENDED_LIMITS.wait);
//
//   // POST /api/new_address — keyed by client IP (no token exists yet):
//   if (path === "/api/new_address" && request.method === "POST") {
//     const rl = createInboxLimiter.check(getClientKey(request));
//     if (!rl.allowed) return rateLimitResponse(rl);
//     // ... existing handler unchanged ...
//   }
//
//   // GET /api/mails — keyed by the inbox token, namespaced so limiters
//   // never collide if they are ever merged into one instance:
//   //   const tok = (request.headers.get("Authorization") || "").replace("Bearer ", "");
//   //   const rl = mailsReadLimiter.check("mails:" + tok);
//   //   if (!rl.allowed) return rateLimitResponse(rl);
//
//   // GET /api/wait — keyed by token AND at most 1 concurrent wait per
//   // token (see RECOMMENDED_LIMITS.wait.maxConcurrent): a long-poll is
//   // itself the pacing mechanism, so clients must not stack waits —
//   // AGENTS.md §2/§6 already require 1 request per wait cycle. Reject /
//   // do not start a second /api/wait while one is outstanding for the
//   // same token; the 6/min cap below is the backstop, not the mechanism.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recommended limits (frozen — pass a spread copy to override one field,
// e.g. createRateLimiter({ ...RECOMMENDED_LIMITS.createInbox, max: 20 })).
// Shape per entry: { windowMs, max, key, ... } — windowMs + max are exactly
// the options createRateLimiter() consumes, extra fields are documentation.
// ---------------------------------------------------------------------------
export const RECOMMENDED_LIMITS = Object.freeze({
  // POST /api/new_address — 10 inbox creations per minute per client IP.
  // IP-keyed because the caller has no token yet. Generous for a human /
  // one agent task, tight enough to blunt bulk inbox farming from one IP.
  createInbox: Object.freeze({
    windowMs: 60_000,
    max: 10,
    per: "minute",
    key: "ip",
    scope: "POST /api/new_address, per client IP (see getClientKey)",
  }),

  // GET /api/mails (+ /api/inboxes/:address/messages reads) — 60 reads per
  // minute per inbox token. Token-keyed, not IP-keyed: many legitimate
  // users/agents can share one NAT IP, while one abusive token should not
  // starve them. 60/min still forbids sub-second polling loops — clients
  // should long-poll /api/wait instead (AGENTS.md §6).
  mailsRead: Object.freeze({
    windowMs: 60_000,
    max: 60,
    per: "minute",
    key: "token",
    scope: "GET /api/mails and message reads, per inbox Bearer token",
  }),

  // GET /api/wait — 6 waits per minute per inbox token, AND at most 1
  // concurrent (outstanding) wait per token.
  // A wait holds for up to ~25 s in worker-v2.js, so 6/min is already more
  // than the ~2-3 sequential cycles/min a well-behaved client can use;
  // the cap only catches clients stacking parallel waits. maxConcurrent
  // is documentation for the call site (see the header example): this
  // fixed-window counter limits rate, it does not track in-flight
  // requests — enforce the concurrent-1 rule where /api/wait is handled.
  wait: Object.freeze({
    windowMs: 60_000,
    max: 6,
    per: "minute",
    key: "token",
    maxConcurrent: 1,
    scope: "GET /api/wait, per inbox Bearer token; concurrent-1: only 1 outstanding wait per token",
  }),
});

// ---------------------------------------------------------------------------
// createRateLimiter({ windowMs, max }) -> check(key)
//
// Fixed-window counter over an in-memory Map (see the header for its
// per-isolate limits). The return value IS the check function, and it also
// carries itself as `.check` (plus `.reset()` / `.size()` helpers), so both
// call styles work:
//   const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
//   limiter("203.0.113.7");        // or
//   limiter.check("203.0.113.7");  // -> { allowed, retryAfterSec, remaining }
//
// check(key):
//   allowed       — true while the key is at or under `max` in this window.
//   remaining     — requests left in this window AFTER this one (0 if denied).
//   retryAfterSec — 0 when allowed; when denied, whole seconds until the
//                   current window resets (always >= 1), ready for the
//                   Retry-After header.
// ---------------------------------------------------------------------------
export function createRateLimiter(options = {}) {
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? Math.floor(options.windowMs)
    : 60_000;
  const max = Number.isFinite(options.max) && options.max > 0
    ? Math.floor(options.max)
    : 60;

  // key -> { count, resetAt } for the key's current window only.
  const buckets = new Map();
  let lastSweep = 0;

  // Opportunistic cleanup so a flood of distinct keys (IPs / tokens) cannot
  // grow the Map without bound: expired buckets are deleted on access in
  // check(), and the whole Map is swept at most once per window (or
  // immediately once it gets large), whichever comes first.
  function sweep(now) {
    if (now - lastSweep < windowMs && buckets.size < 1000) return;
    lastSweep = now;
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }

  function check(key) {
    const k = key === undefined || key === null || key === "" ? "unknown" : String(key);
    const now = Date.now();
    sweep(now);

    let bucket = buckets.get(k);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(k, bucket);
    }

    if (bucket.count >= max) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        remaining: 0,
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      retryAfterSec: 0,
      remaining: Math.max(0, max - bucket.count),
    };
  }

  // Aliases / introspection for call sites and tests. Not part of the
  // required surface — check() above is.
  check.check = check;
  check.reset = (key) => {
    if (key === undefined) buckets.clear();
    else buckets.delete(String(key));
  };
  check.size = () => buckets.size;
  check.windowMs = windowMs;
  check.max = max;
  return check;
}

// ---------------------------------------------------------------------------
// getClientKey(request) -> string
//
// The rate-limit key for an unauthenticated request: the client IP.
// `CF-Connecting-IP` is set by Cloudflare on every request reaching the
// Worker and cannot be spoofed by the client through Cloudflare, so it
// always wins. `X-Forwarded-For` is only a fallback for running outside
// Cloudflare (local dev / wrangler dev / tests) — it IS client-spoofable,
// so never prefer it when CF-Connecting-IP exists. For XFF, the first
// entry in the list is the original client. Returns "unknown" when no
// usable header is present (all such callers share one bucket, which is
// the conservative outcome).
// ---------------------------------------------------------------------------
export function getClientKey(request) {
  const headers = request && request.headers;
  if (!headers || typeof headers.get !== "function") return "unknown";

  const cfIp = (headers.get("CF-Connecting-IP") || "").trim();
  if (cfIp) return cfIp;

  const xff = headers.get("X-Forwarded-For") || "";
  const first = xff.split(",")[0].trim();
  if (first) return first;

  return "unknown";
}

// ---------------------------------------------------------------------------
// rateLimitResponse(result) -> Response (429)
//
// Build the denial response for a failed check():
//   const rl = limiter.check(key);
//   if (!rl.allowed) return rateLimitResponse(rl);
// JSON body (matching worker-v2.js's { error, ... } style) plus a
// `Retry-After` header in whole seconds, CORS headers mirroring
// worker-v2.js so browser / UI clients can actually read the 429, and
// `Cache-Control: no-store` — a denial must never be cached.
// Accepts the object check() returns; anything missing/invalid falls back
// to a 60-second retry hint rather than throwing.
// ---------------------------------------------------------------------------
export function rateLimitResponse(result = {}) {
  const retryAfterSec = Number.isFinite(result.retryAfterSec) && result.retryAfterSec > 0
    ? Math.ceil(result.retryAfterSec)
    : 60;
  const remaining = Number.isFinite(result.remaining) && result.remaining > 0
    ? Math.floor(result.remaining)
    : 0;

  return new Response(
    JSON.stringify({
      error: "Too many requests",
      code: "rate_limited",
      retryAfterSec,
      retry_after: retryAfterSec,
      remaining,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
        "X-RateLimit-Remaining": String(remaining),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization,Content-Type,If-None-Match",
      },
    },
  );
}

export default createRateLimiter;
