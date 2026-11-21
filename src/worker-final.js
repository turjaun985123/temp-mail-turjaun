// Temp Mail v2 INTEGRATED for turjaun.xyz - SINGLE FILE Worker, zero dependencies, ESM, ZERO IMPORTS
// This is worker-v2.js with rate-limit.js and webhooks.js INLINED (the live
// deploy is a single-file API upload, so `./rate-limit.js` / `./webhooks.js`
// imports would not resolve). Rate limiting + HMAC webhooks are built in;
// all worker-v2 endpoints/behaviour are otherwise identical.
// Extra vars: WEBHOOK_URL, WEBHOOK_SECRET (both optional, see webhook block)
// Improved core Worker: long-poll (/api/wait), cursor pagination, ETag/caching,
// OTP + verification-link extraction. All v1 endpoints preserved.
// Bindings needed: D1 binding named DB -> temp-mail-db
// Vars: DOMAINS="turjaun.xyz", MAIL_TTL_HOURS="24"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function domains(env) { return (env.DOMAINS || "turjaun.xyz").split(",").map(s => s.trim().toLowerCase()).filter(Boolean); }
function rnd(len = 10) { const c = "abcdefghijklmnopqrstuvwxyz0123456789"; const a = new Uint8Array(len); crypto.getRandomValues(a); return Array.from(a).map(b => c[b % c.length]).join(""); }
function token() { const a = new Uint8Array(32); crypto.getRandomValues(a); return Array.from(a).map(b => b.toString(16).padStart(2, "0")).join(""); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function intParam(url, name, fallback) { const v = parseInt(url.searchParams.get(name) || "", 10); return Number.isFinite(v) ? v : fallback; }

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type,If-None-Match" };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders } });
}
// Mutations (POST/DELETE) must never be cached.
function jsonNoStore(data, status = 200) { return json(data, status, { "Cache-Control": "no-store" }); }

// Tiny deterministic hash for ETags (FNV-1a over the payload string).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
// List responses: ETag + Cache-Control: private, max-age=2, with 304 support.
function listJson(request, data) {
  const body = JSON.stringify(data);
  const etag = '"' + fnv1a(body) + '"';
  const headers = { "Content-Type": "application/json", ...CORS, "Cache-Control": "private, max-age=2", "ETag": etag };
  const inm = request.headers.get("If-None-Match") || "";
  if (inm === etag || inm === "W/" + etag) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
}


// ---------------------------------------------------------------------------
// INLINED from rate-limit.js (single-file deploy: no ES imports resolve in
// the live API upload, so this code is copied verbatim, minus its
// `export default createRateLimiter` — the Worker's default export wins).
// In-memory fixed-window limiter: counters live in a module-level Map in
// ONE Worker isolate, so limits are per-isolate / best-effort only (they
// slow naive abuse and protect D1; they are not a global security boundary
// — see rate-limit.js for the Durable Object upgrade path).
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

// One limiter per endpoint, created once at module scope (NOT per-request,
// or the Map would reset every call). Task-specified limits:
//   POST /api/new_address : 10/min per client IP
//   GET  /api/mails       : 60/min per inbox token
//   GET  /api/wait        : 60/min per inbox token (task spec for this
//                           integrated build — overrides RECOMMENDED_LIMITS.wait,
//                           whose documented default is 6/min)
const createInboxLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
const mailsReadLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const waitLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

// ---------------------------------------------------------------------------
// OTP + verification-link extraction
// ---------------------------------------------------------------------------
export function extractOTP(text) {
  const t = text || "";
  // Prefer a code near a keyword (code / OTP / verification / pin / passcode...).
  const kw = t.match(/(?:verification\s*code|security\s*code|one[- ]time(?:\s*(?:code|password|pin))?|otp|passcode|pin|code)[^0-9]{0,40}(\d{4,8})\b/i);
  if (kw) return kw[1];
  const m = t.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}
// Back-compat name used by v1 code paths.
function otp(text) { return extractOTP(text); }

export function extractLinks(text, html) {
  const found = [];
  const seen = new Set();
  const push = (u) => {
    if (!u) return;
    const clean = String(u).replace(/&amp;/g, "&").replace(/[)\].,;'"<>]+$/, "");
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean); found.push(clean);
  };
  // hrefs from HTML first (most reliable for verification buttons).
  if (html) { const re = /href\s*=\s*["'](https?:\/\/[^"'<>\s]+)["']/gi; let m; while ((m = re.exec(html)) !== null) push(m[1]); }
  const all = (text || "") + " " + (html || "").replace(/<[^>]+>/g, " ");
  const urlRe = /https?:\/\/[^\s"'<>\\)]+/gi; let u; const plain = [];
  while ((u = urlRe.exec(all)) !== null) plain.push(u[0]);
  // Verification-looking links first, then any other links found in the body.
  const isVerify = (x) => /(verif|confirm|activat|validat|reset|magic|sign[-_]?in|login|token=|code=|auth)/i.test(x);
  for (const x of plain) if (isVerify(x)) push(x);
  for (const x of plain) push(x);
  return found;
}
export function extractVerificationLinks(text, html) { return extractLinks(text, html).filter(x => /(verif|confirm|activat|validat|reset|magic|sign[-_]?in|login|token=|code=|auth)/i.test(x)); }

function enrichMail(r, full = true) {
  const bodyText = (r.text_body || r.preview || "") + " " + (r.subject || "");
  const links = full ? extractLinks(r.text_body || "", r.html_body || "") : extractLinks(bodyText, "");
  const vlinks = links.filter(x => /(verif|confirm|activat|validat|reset|magic|sign[-_]?in|login|token=|code=|auth)/i.test(x));
  return { ...r, otp: extractOTP(bodyText), verification_links: vlinks, links };
}

// ---------------------------------------------------------------------------
// MIME parsing (JS implementation)
// RUST_WASM_HOOK: parseRaw is the single parsing entry point for the email()
// handler. To swap in the Rust/WASM parser later, replace the body of
// parseRaw (or re-export a WASM-backed implementation with the same
// signature: parseRaw(raw: string) -> {subject, text, html, from}) and keep
// every caller unchanged. No other code in this file parses raw MIME.
// ---------------------------------------------------------------------------
function decodeQP(s) { return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
function decodeB64(s) { try { return atob(s.replace(/\s/g, "")); } catch { return s; } }

export function parseRaw(raw) {
  const split = raw.indexOf("\r\n\r\n"); const split2 = raw.indexOf("\n\n");
  let hi, bi; if (split >= 0) { hi = split; bi = split + 4; } else if (split2 >= 0) { hi = split2; bi = split2 + 2; } else { hi = 0; bi = 0; }
  const headersRaw = raw.slice(0, hi); const bodyRaw = raw.slice(bi);
  const headers = {}; let cur = "";
  for (const line of headersRaw.split(/\r?\n/)) {
    if (/^\s/.test(line) && cur) { headers[cur] += " " + line.trim(); }
    else { const idx = line.indexOf(":"); if (idx > 0) { cur = line.slice(0, idx).toLowerCase(); headers[cur] = line.slice(idx + 1).trim(); } }
  }
  const subject = headers["subject"] || "(no subject)";
  let text = bodyRaw, html = "";
  const ct = (headers["content-type"] || "").toLowerCase(); const enc = (headers["content-transfer-encoding"] || "").toLowerCase();
  const bm = ct.match(/boundary="?([^";]+)"?/);
  if (bm) {
    const parts = bodyRaw.split("--" + bm[1]);
    let t = "", h = "";
    for (const part of parts) {
      const ps = part.indexOf("\r\n\r\n") >= 0 ? part.indexOf("\r\n\r\n") + 4 : (part.indexOf("\n\n") >= 0 ? part.indexOf("\n\n") + 2 : 0);
      const ph = part.slice(0, ps); const pb = part.slice(ps);
      const pct = ph.toLowerCase(); const penc = (ph.match(/content-transfer-encoding:\s*(\S+)/i) || [])[1] || "";
      let decoded = pb; if (penc.toLowerCase().includes("base64")) decoded = decodeB64(pb); else if (penc.toLowerCase().includes("quoted")) decoded = decodeQP(pb);
      if (pct.includes("text/html")) h += decoded; else if (pct.includes("text/plain")) t += decoded;
    }
    text = t || text; html = h;
  } else {
    if (enc.includes("base64")) text = decodeB64(bodyRaw);
    else if (enc.includes("quoted-printable")) text = decodeQP(bodyRaw);
    if (ct.includes("text/html")) { html = text; text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
  }
  return { subject, text: text.slice(0, 50000), html: html.slice(0, 50000), from: headers["from"] || "" };
}

// ---------------------------------------------------------------------------
// UI placeholder: Agent 3/4's UI replaces UI_HTML during integration.
// Functional v1 UI kept (shortened) so the Worker works standalone.
// ---------------------------------------------------------------------------
export const UI_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"description\" content=\"Fast disposable temp mail for turjaun.xyz — create an inbox in one click, receive mail instantly, copy OTP codes.\">\n<meta name=\"color-scheme\" content=\"dark\">\n<title>Temp Mail — turjaun.xyz</title>\n<style>\n/* Critical inline CSS — page is fully usable standalone even if styles.css fails to load.\n   styles.css (owned separately) layers the full design system on top of these basics. */\n:root{--bg:#0b1220;--surface:#111a2e;--surface2:#16223c;--border:#24304d;--text:#e6edf7;--muted:#8b9bb4;--accent:#3b82f6;--accent2:#2563eb;--ok:#22c55e;--warn:#f59e0b;--danger:#ef4444;--radius:14px}\n*{box-sizing:border-box}\nhtml,body{margin:0;padding:0}\nbody{font-family:system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased}\na{color:var(--accent)}\nbutton,input,select{font:inherit;color:var(--text)}\nbutton{cursor:pointer;border:1px solid var(--border);background:var(--surface2);border-radius:10px;padding:.6rem 1rem;min-height:44px}\nbutton:hover{border-color:var(--accent)}\nbutton.primary,button#createBtn{background:var(--accent2);border-color:var(--accent2);color:#fff;font-weight:600}\nbutton:disabled{opacity:.55;cursor:wait}\ninput,select{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:.6rem .8rem;min-height:44px;width:100%}\ninput:focus,select:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.app-header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;padding:.8rem 1rem;background:rgba(11,18,32,.92);border-bottom:1px solid var(--border)}\n.brand{display:flex;align-items:center;gap:.6rem;font-weight:700;font-size:1.15rem}\n.brand .logo{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;background:var(--accent2);color:#fff}\n.domain-badge{display:inline-flex;align-items:center;gap:.35rem;padding:.25rem .65rem;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--muted);font-size:.85rem;font-weight:600}\n.domain-badge::before{content:\"\";width:8px;height:8px;border-radius:50%;background:var(--ok)}\n#status{display:inline-flex;align-items:center;gap:.45rem;margin-left:auto;color:var(--muted);font-size:.88rem}\n#status .dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex:none}\n#status[data-state=\"live\"] .dot{background:var(--ok)}\n#status[data-state=\"polling\"] .dot{background:var(--warn)}\n#status[data-state=\"error\"] .dot{background:var(--danger)}\nmain.layout{max-width:1100px;margin:0 auto;padding:1rem;display:grid;gap:1rem;grid-template-columns:1fr}\n@media(min-width:900px){main.layout{grid-template-columns:380px 1fr;align-items:start}.pane-detail{grid-column:2}.pane-inbox{grid-row:span 2}}\n.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem}\n.card h2,.card h3{margin:.1rem 0 .7rem;font-size:1rem}\n.muted{color:var(--muted)} .small{font-size:.85rem}\n.create-row{display:flex;gap:.5rem;flex-wrap:wrap}\n.create-row .grow{flex:1 1 140px}\n.addr-row{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-top:.9rem;padding:.7rem .8rem;background:var(--surface2);border:1px dashed var(--border);border-radius:10px}\n#addr{font-weight:700;word-break:break-all;flex:1 1 180px}\n.token-row{margin-top:.5rem;word-break:break-all}\n#token{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;color:var(--muted)}\n.inbox-tools{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.7rem}\n.inbox-tools .grow{flex:1 1 160px}\n#inbox{display:flex;flex-direction:column}\n#inbox .mail,#inbox article{padding:.75rem .5rem;border-top:1px solid var(--border);cursor:pointer;border-radius:8px}\n#inbox .mail:hover,#inbox article:hover{background:var(--surface2)}\n#inbox .empty{padding:1.2rem .5rem;color:var(--muted);text-align:center}\n#view{white-space:pre-wrap;word-break:break-word;margin:0;font-family:inherit}\n.otp-box{display:none;margin:0 0 1rem;padding:1rem;text-align:center;background:var(--surface2);border:1px solid var(--accent);border-radius:var(--radius)}\n.otp-box.visible{display:block}\n.otp-label{color:var(--muted);font-size:.8rem;letter-spacing:.12em;text-transform:uppercase}\n#otpCode,.otp-code{display:block;font-size:2.4rem;font-weight:800;letter-spacing:.35em;margin:.35rem 0 .6rem;font-variant-numeric:tabular-nums}\n#toastArea,.toast-area{position:fixed;right:1rem;bottom:1rem;z-index:50;display:flex;flex-direction:column;gap:.5rem;max-width:min(92vw,360px)}\n.toast{background:var(--surface2);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:10px;padding:.7rem .9rem;box-shadow:0 8px 24px rgba(0,0,0,.35)}\n.toast.success{border-left-color:var(--ok)} .toast.error{border-left-color:var(--danger)}\n.app-footer{max-width:1100px;margin:0 auto;padding:0 1rem 2rem;color:var(--muted);font-size:.85rem}\n.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}\n</style>\n<style>\n/* --- inlined: ui/styles.css (scripts/build-ui.mjs) --- */\n/* Temp Mail v2 — turjaun.xyz\n   Modern dark UI (light via prefers-color-scheme). No external fonts.\n   Names cover v1 (header,.card,.mail,#inbox,#view,#name,#domain,#addr,#token)\n   and conventional v2 (.layout,.panes,.otp,#status,.toast,.skeleton). */\n\n:root{\n  color-scheme:dark;\n  --bg:#0b1220; --bg-2:#0f172a;\n  --surface:#1e293b; --surface-2:#162032; --surface-hover:#243449;\n  --border:#334155; --border-strong:#475569;\n  --text:#e2e8f0; --text-strong:#f8fafc; --muted:#94a3b8; --faint:#64748b;\n  --accent:#2563eb; --accent-hover:#1d4ed8; --accent-active:#1e40af; --accent-text:#fff;\n  --accent-soft:rgba(37,99,235,.16);\n  --ok:#22c55e; --ok-soft:rgba(34,197,94,.14);\n  --danger:#f87171; --danger-soft:rgba(248,113,113,.12);\n  --otp-bg:#0b1220;\n  --shadow:0 10px 30px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.25);\n  --shadow-sm:0 1px 3px rgba(0,0,0,.3);\n  --radius:12px; --radius-sm:8px; --radius-lg:16px;\n  --gap:16px;\n  --font:system-ui,-apple-system,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif;\n  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,\"Liberation Mono\",monospace;\n  --focus:#60a5fa;\n  --skeleton-1:#1e293b; --skeleton-2:#2b3c55;\n  --toast-bg:#f8fafc; --toast-text:#0f172a;\n}\n@media (prefers-color-scheme:light){\n  :root{\n    color-scheme:light;\n    --bg:#f1f5f9; --bg-2:#e8eef6;\n    --surface:#fff; --surface-2:#f8fafc; --surface-hover:#eef4fb;\n    --border:#cbd5e1; --border-strong:#94a3b8;\n    --text:#1e293b; --text-strong:#0f172a; --muted:#64748b; --faint:#94a3b8;\n    --accent-soft:rgba(37,99,235,.1);\n    --ok-soft:rgba(34,197,94,.12);\n    --otp-bg:#f8fafc;\n    --shadow:0 10px 30px rgba(15,23,42,.12),0 2px 8px rgba(15,23,42,.08);\n    --shadow-sm:0 1px 3px rgba(15,23,42,.12);\n    --focus:#2563eb;\n    --skeleton-1:#e2e8f0; --skeleton-2:#f1f5f9;\n    --toast-bg:#0f172a; --toast-text:#f8fafc;\n  }\n}\n\n/* ---------- Base / layout ---------- */\n*,*::before,*::after{box-sizing:border-box}\nhtml{-webkit-text-size-adjust:100%}\nbody{\n  margin:0; font-family:var(--font); line-height:1.55;\n  background:linear-gradient(180deg,var(--bg-2),var(--bg) 240px) var(--bg);\n  color:var(--text); min-height:100vh;\n}\n.container,.wrap,main{\n  max-width:1080px; margin:0 auto; padding:32px 16px 56px; width:100%;\n}\nh1,h2,h3{color:var(--text-strong); line-height:1.25; margin:0 0 8px}\nh1{font-size:clamp(1.5rem,3vw,2rem); letter-spacing:-.02em}\nh2{font-size:1.2rem} h3{font-size:1rem}\np{margin:0 0 10px}\na{color:var(--focus); text-underline-offset:2px}\nsmall,.muted{color:var(--muted)} .faint{color:var(--faint)}\n.mono,code,kbd{font-family:var(--mono)}\n::selection{background:var(--accent); color:var(--accent-text)}\n\n/* Header */\nheader,.header,.app-header{\n  display:flex; align-items:center; gap:12px; flex-wrap:wrap;\n  margin-bottom:20px;\n}\nheader h1,.header h1{margin:0; flex:1 1 auto; min-width:0}\n.tagline,.subtitle{color:var(--muted); width:100%; margin-top:-4px}\n.logo,.brand-mark{font-size:1.6rem; line-height:1}\n\n/* Two-pane: inbox list + message detail */\n.layout,.panes,.main-grid{\n  display:grid; gap:var(--gap); align-items:start;\n  grid-template-columns:minmax(320px,5fr) minmax(0,7fr);\n}\n.pane,.pane-inbox,.pane-detail{min-width:0}\n.controls,.toolbar,.actions,.row{\n  display:flex; gap:8px; flex-wrap:wrap; align-items:center;\n}\n.controls>*{min-width:0}\n.spacer{flex:1 1 auto}\n.stack{display:grid; gap:var(--gap)}\n\n/* ---------- Cards ---------- */\n.card{\n  background:var(--surface); border:1px solid var(--border);\n  border-radius:var(--radius); padding:16px; margin:0 0 var(--gap);\n  box-shadow:var(--shadow-sm);\n}\n.card>h2,.card>h3{margin-bottom:12px}\n.card-header{\n  display:flex; align-items:center; gap:10px; margin-bottom:12px;\n}\n.card-header h2,.card-header h3{margin:0; flex:1 1 auto}\n\n/* ---------- Forms / buttons ---------- */\ninput,select,textarea,button{\n  font:inherit; padding:10px 12px; border-radius:var(--radius-sm);\n  border:1px solid var(--border); background:var(--surface-2); color:var(--text);\n  min-height:42px;\n}\ninput,select,textarea{accent-color:var(--accent)}\ninput::placeholder,textarea::placeholder{color:var(--faint)}\ninput:hover,select:hover,textarea:hover{border-color:var(--border-strong)}\ninput:disabled,select:disabled,button:disabled{opacity:.55; cursor:not-allowed}\n#name{flex:1 1 180px}\n#domain{flex:0 1 auto}\nlabel{font-weight:600; color:var(--text-strong); display:inline-block; margin-bottom:6px}\n.field{display:grid; gap:6px; margin-bottom:12px}\n\nbutton,.btn{\n  background:var(--surface); color:var(--text); border:1px solid var(--border);\n  cursor:pointer; font-weight:600; white-space:nowrap;\n  display:inline-flex; align-items:center; justify-content:center; gap:8px;\n  transition:background .15s ease,border-color .15s ease,transform .05s ease;\n}\nbutton:hover,.btn:hover{background:var(--surface-hover); border-color:var(--border-strong)}\nbutton:active,.btn:active{transform:translateY(1px)}\nbutton.primary,.btn-primary,.primary{\n  background:var(--accent); border-color:transparent; color:var(--accent-text);\n}\nbutton.primary:hover,.btn-primary:hover,.primary:hover{background:var(--accent-hover)}\nbutton.primary:active,.btn-primary:active,.primary:active{background:var(--accent-active)}\n.btn-danger,.danger{color:var(--danger)}\n.btn-ghost,.ghost{background:transparent; border-color:transparent}\n.btn-ghost:hover,.ghost:hover{background:var(--surface-hover)}\n.btn-sm,button.small{padding:6px 10px; min-height:34px; font-size:.9rem}\n.btn-block{width:100%}\n\n/* Address / token display */\n#addr,.address-value{\n  color:var(--text-strong); font-family:var(--mono); font-size:1.02rem;\n  overflow-wrap:anywhere; user-select:all;\n}\n.address-row{\n  display:flex; align-items:center; gap:8px; flex-wrap:wrap;\n  background:var(--surface-2); border:1px solid var(--border);\n  border-radius:var(--radius-sm); padding:10px 12px; margin:10px 0;\n}\n.address-row #addr{flex:1 1 auto}\n#token,.token-value{\n  font-family:var(--mono); font-size:.82rem; color:var(--muted);\n  overflow-wrap:anywhere; user-select:all;\n}\n\n/* ---------- Status ---------- */\n#status,.status{\n  display:inline-flex; align-items:center; gap:8px;\n  font-size:.9rem; color:var(--muted);\n}\n.status-dot,.dot{\n  width:10px; height:10px; border-radius:50%; flex:0 0 auto;\n  background:var(--faint); position:relative;\n}\n.status-dot.live,.status-dot.waiting,.dot.live,\n#status.live .status-dot,#status.waiting .status-dot{\n  background:var(--ok);\n}\n.status-dot.live::after,.status-dot.waiting::after,.dot.live::after,\n#status.live .status-dot::after,#status.waiting .status-dot::after{\n  content:\"\"; position:absolute; inset:-4px; border-radius:50%;\n  border:2px solid var(--ok); opacity:.6;\n  animation:pulse 1.8s ease-out infinite;\n}\n.status-dot.paused,.dot.paused,#status.paused .status-dot{background:var(--faint)}\n.status-dot.error,.dot.error,#status.error .status-dot{background:var(--danger)}\n@keyframes pulse{\n  0%{transform:scale(.6); opacity:.7}\n  70%,100%{transform:scale(1.25); opacity:0}\n}\n.badge,.pill{\n  display:inline-flex; align-items:center; gap:6px; padding:2px 9px;\n  border-radius:999px; font-size:.78rem; font-weight:700;\n  background:var(--accent-soft); color:var(--focus);\n}\n.badge.ok{background:var(--ok-soft); color:var(--ok)}\n.count{color:var(--muted); font-weight:600}\n\n/* ---------- Inbox / mail list ---------- */\n#inbox,.mail-list{list-style:none; margin:0; padding:0}\n.empty,.empty-state{\n  color:var(--muted); text-align:center; padding:28px 12px;\n  border:1px dashed var(--border); border-radius:var(--radius-sm);\n}\n.mail{\n  display:block; width:100%; text-align:left;\n  padding:12px 10px; margin:0; min-height:0;\n  background:transparent; border:0; border-top:1px solid var(--border);\n  border-radius:0; color:var(--text); cursor:pointer; font-weight:400;\n  transition:background .12s ease;\n}\nli.mail,div.mail{border-top:1px solid var(--border)}\n.mail:first-child{border-top:0}\n.mail:hover{background:var(--surface-hover)}\n.mail.selected,.mail.active{background:var(--accent-soft)}\n.mail.unread{font-weight:600}\n.mail.unread .mail-subject,.mail.unread b{color:var(--text-strong)}\n.mail.unread::before,.unread-dot{\n  content:\"\"; display:inline-block; width:8px; height:8px; border-radius:50%;\n  background:var(--accent); margin-right:8px; vertical-align:middle; flex:0 0 auto;\n}\n.mail-subject,.mail b{\n  color:var(--text-strong); display:block;\n  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;\n}\n.mail-meta,.mail small{\n  color:var(--muted); font-size:.84rem;\n  display:flex; gap:6px; flex-wrap:wrap; justify-content:space-between;\n}\n.mail-sender{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:65%}\n.mail-time{white-space:nowrap; flex:0 0 auto}\n.mail-preview,.preview{\n  color:var(--muted); font-size:.9rem; font-weight:400;\n  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;\n}\n\n/* ---------- Message detail ---------- */\n#view,.message-body,.mail-body{\n  white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere;\n  font-family:var(--font); font-size:.96rem; margin:0;\n  background:var(--surface-2); border:1px solid var(--border);\n  border-radius:var(--radius-sm); padding:14px; min-height:120px;\n}\n#view:empty::before{content:\"Select a message to read it\"; color:var(--faint)}\n.message-header{border-bottom:1px solid var(--border); padding-bottom:12px; margin-bottom:12px}\n.message-header h2,.message-subject{overflow-wrap:anywhere}\n.message-meta{color:var(--muted); font-size:.9rem; display:grid; gap:2px}\n.message-frame,.html-frame{width:100%; border:1px solid var(--border); border-radius:var(--radius-sm); background:#fff; min-height:300px}\npre#view{font-family:var(--font)}\n\n/* ---------- OTP ---------- */\n.otp,.otp-code,#otp{\n  display:flex; align-items:center; justify-content:center; gap:10px; flex-wrap:wrap;\n  font-family:var(--mono); font-size:2rem; font-weight:800; letter-spacing:.35em;\n  text-indent:.35em; /* optically re-centre letter-spaced digits */\n  color:var(--text-strong); background:var(--otp-bg);\n  border:2px dashed var(--border-strong); border-radius:var(--radius);\n  padding:16px 12px; margin:12px 0; user-select:all; cursor:copy;\n  text-align:center; overflow-wrap:anywhere;\n}\n.otp-label{\n  display:block; text-align:center; font-size:.78rem; font-weight:700;\n  letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:4px;\n}\n.otp small{letter-spacing:normal; text-indent:0; font-size:.85rem}\n\n/* ---------- Toast ---------- */\n.toast,#toast{\n  position:fixed; left:50%; bottom:24px; transform:translate(-50%,16px);\n  z-index:1000; max-width:min(92vw,480px);\n  background:var(--toast-bg); color:var(--toast-text);\n  padding:12px 18px; border-radius:999px; box-shadow:var(--shadow);\n  font-weight:600; font-size:.95rem; text-align:center;\n  opacity:0; pointer-events:none;\n  transition:opacity .2s ease,transform .2s ease;\n}\n.toast.show,#toast.show,.toast.visible{opacity:1; transform:translate(-50%,0); pointer-events:auto}\n.toast.error{background:var(--danger); color:#fff}\n.toast.success{background:var(--ok); color:#052e12}\n#toasts,.toast-container{position:fixed; left:50%; bottom:24px; transform:translateX(-50%); z-index:1000; display:grid; gap:8px; justify-items:center}\n#toasts .toast,.toast-container .toast{position:static; transform:none; opacity:1; pointer-events:auto}\n\n/* ---------- Skeleton loading ---------- */\n.skeleton{\n  border-radius:var(--radius-sm); min-height:14px;\n  background:linear-gradient(100deg,var(--skeleton-1) 40%,var(--skeleton-2) 50%,var(--skeleton-1) 60%);\n  background-size:200% 100%; animation:shimmer 1.4s linear infinite;\n}\n.skeleton-mail{padding:12px 10px; border-top:1px solid var(--border); display:grid; gap:8px}\n.skeleton-mail:first-child{border-top:0}\n.skeleton-line{height:14px}\n.skeleton-line.short{width:45%} .skeleton-line.mid{width:70%} .skeleton-line.long{width:92%}\n.skeleton-title{height:20px; width:55%}\n.skeleton-otp{height:64px; border-radius:var(--radius)}\n.loading{opacity:.75; pointer-events:none}\n.spinner{\n  width:16px; height:16px; border-radius:50%; flex:0 0 auto;\n  border:2px solid var(--border); border-top-color:var(--accent);\n  animation:spin .7s linear infinite; display:inline-block;\n}\n@keyframes shimmer{to{background-position:-200% 0}}\n@keyframes spin{to{transform:rotate(360deg)}}\n\n/* ---------- Misc ---------- */\n.error,.alert-error{\n  background:var(--danger-soft); color:var(--danger);\n  border:1px solid var(--danger); border-radius:var(--radius-sm); padding:10px 12px;\n}\n.notice{background:var(--accent-soft); border-radius:var(--radius-sm); padding:10px 12px}\nhr{border:0; border-top:1px solid var(--border); margin:16px 0}\nfooter,.footer{color:var(--faint); font-size:.88rem; text-align:center; margin-top:28px}\n[hidden]{display:none!important}\n.sr-only{position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap}\n\n/* ---------- Focus ---------- */\n:focus{outline:none}\n:focus-visible,\na:focus-visible,button:focus-visible,.btn:focus-visible,\ninput:focus-visible,select:focus-visible,textarea:focus-visible,\n.mail:focus-visible,.otp:focus-visible{\n  outline:3px solid var(--focus); outline-offset:2px;\n}\ninput:focus,select:focus,textarea:focus{border-color:var(--focus)}\n\n/* ---------- Responsive ---------- */\n@media (max-width:720px){\n  .container,.wrap,main{padding:20px 12px 40px}\n  .layout,.panes,.main-grid{grid-template-columns:1fr}\n  .card{padding:14px}\n  header,.header,.app-header{margin-bottom:14px}\n  .controls,.toolbar,.actions{width:100%}\n  .controls>input,.controls>select,.controls>button,\n  .toolbar>button,.actions>button{flex:1 1 auto}\n  #name{flex:1 1 100%}\n  #domain{flex:1 1 auto}\n  .otp,.otp-code,#otp{font-size:1.55rem; letter-spacing:.22em; text-indent:.22em; padding:13px 8px}\n  .mail-meta,.mail small{justify-content:flex-start}\n  .mail-sender{max-width:100%}\n  .toast,#toast{bottom:14px}\n  #view,.message-body{min-height:80px}\n}\n\n/* ---------- Reduced motion ---------- */\n@media (prefers-reduced-motion:reduce){\n  *,*::before,*::after{\n    animation-duration:.01ms!important; animation-iteration-count:1!important;\n    transition-duration:.01ms!important; scroll-behavior:auto!important;\n  }\n  .status-dot.live::after,.status-dot.waiting::after,.dot.live::after{animation:none; opacity:0}\n  .skeleton{animation:none}\n  .spinner{animation:none}\n}\n\n</style>\n</head>\n<body>\n\n<!-- ================= Header ================= -->\n<header class=\"app-header\">\n  <div class=\"brand\">\n    <span class=\"logo\" aria-hidden=\"true\">\n      <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"/><path d=\"m22 7-10 6L2 7\"/></svg>\n    </span>\n    <span>Temp Mail</span>\n  </div>\n  <span class=\"domain-badge\" id=\"domainBadge\" title=\"Mail domain served by this inbox\">turjaun.xyz</span>\n  <!-- Auto-refresh status: app.js sets data-state to live | polling | paused | error and updates the text -->\n  <div id=\"status\" class=\"status\" data-state=\"idle\" role=\"status\" aria-live=\"polite\">\n    <span class=\"dot\" aria-hidden=\"true\"></span>\n    <span id=\"statusText\">Not started</span>\n  </div>\n</header>\n\n<main class=\"layout\">\n\n  <!-- ================= Create inbox ================= -->\n  <section class=\"card pane-create\" aria-labelledby=\"createHeading\">\n    <h2 id=\"createHeading\">Your inbox</h2>\n\n    <label class=\"sr-only\" for=\"name\">Custom inbox name (optional)</label>\n    <div class=\"create-row\">\n      <input id=\"name\" class=\"grow\" type=\"text\" inputmode=\"text\" autocomplete=\"off\" spellcheck=\"false\"\n             placeholder=\"custom name (optional)\" maxlength=\"64\">\n      <label class=\"sr-only\" for=\"domain\">Domain</label>\n      <select id=\"domain\" aria-label=\"Domain\">\n        <option value=\"turjaun.xyz\" selected>turjaun.xyz</option>\n      </select>\n    </div>\n    <div class=\"create-row\" style=\"margin-top:.6rem\">\n      <button id=\"createBtn\" class=\"primary\" type=\"button\">Create inbox</button>\n      <button id=\"randomBtn\" type=\"button\">Random inbox</button>\n    </div>\n\n    <div class=\"addr-row\">\n      <span class=\"muted small\" id=\"addrLabel\">Address</span>\n      <!-- app.js contract (v1): POST /api/new_address -> {address, token} -->\n      <span id=\"addr\" aria-labelledby=\"addrLabel\">—</span>\n      <button id=\"copyAddr\" type=\"button\" disabled aria-label=\"Copy email address\">Copy</button>\n    </div>\n    <p class=\"token-row small\">\n      <span class=\"muted\">Token:</span>\n      <!-- app.js uses this token as: Authorization: Bearer &lt;token&gt; on GET /api/mails -->\n      <span id=\"token\">—</span>\n    </p>\n    <p class=\"muted small\">Mails are kept for 24 hours, then deleted automatically. Anyone who can guess this address can read its mail — use a random name for anything sensitive.</p>\n  </section>\n\n  <!-- ================= Inbox list ================= -->\n  <section class=\"card pane-inbox\" aria-labelledby=\"inboxHeading\">\n    <h2 id=\"inboxHeading\">Inbox</h2>\n    <div class=\"inbox-tools\">\n      <label class=\"sr-only\" for=\"search\">Filter messages</label>\n      <input id=\"search\" class=\"grow\" type=\"search\" autocomplete=\"off\" placeholder=\"Filter by sender or subject…\">\n      <button id=\"refreshBtn\" type=\"button\" aria-label=\"Refresh inbox\">Refresh</button>\n    </div>\n    <!-- app.js renders one .mail / <article> per message here (GET /api/mails, Bearer token).\n         Each item should carry data-id so clicks can load GET /api/mail/:id into #view. -->\n    <div id=\"inbox\" role=\"list\" aria-label=\"Messages\">\n      <div class=\"empty\">Create an inbox first — then send mail to it and it will appear here.</div>\n    </div>\n  </section>\n\n  <!-- ================= Message detail ================= -->\n  <section class=\"card pane-detail\" aria-labelledby=\"viewHeading\">\n    <h2 id=\"viewHeading\">Message</h2>\n\n    <!-- OTP: app.js shows .otp-box (adds .visible) and fills #otpCode when a code is detected in the open message -->\n    <div class=\"otp-box\" id=\"otpBox\">\n      <span class=\"otp-label\">Verification code</span>\n      <span class=\"otp-code\" id=\"otpCode\">——————</span>\n      <button id=\"copyOtp\" type=\"button\">Copy code</button>\n    </div>\n\n    <!-- app.js contract (v1): GET /api/mail/:id -> fills this pane (subject, sender, time, body) -->\n    <div id=\"view\" aria-live=\"polite\">Select a message from your inbox to read it here.</div>\n  </section>\n\n</main>\n\n<footer class=\"app-footer\">\n  <p>Temp Mail for <strong>turjaun.xyz</strong> · Disposable inboxes — do not use for important accounts · Mail auto-deletes after 24 hours</p>\n</footer>\n\n<!-- Toasts: app.js appends .toast elements here (success / error / info) -->\n<div id=\"toastArea\" class=\"toast-area\" aria-live=\"polite\" aria-atomic=\"false\"></div>\n\n<script>\n/* --- inlined: ui/app.js (scripts/build-ui.mjs) --- */\n'use strict';\n/*\n * Temp Mail v2 - UI app (vanilla JS, no frameworks)\n * Domain: turjaun.xyz - Worker API contract (v1 + v2 /api/wait)\n *\n * Fast message showing:\n *  - Long-poll loop on GET /api/wait?since_id=N (server holds up to 25s,\n *    returns immediately when a new mail arrives).\n *  - Falls back to 3s polling on /api/mails if /api/wait errors.\n *  - Pauses while the tab is hidden (visibilitychange), resumes on return.\n *  - Incremental rendering: a mail node is created once, keyed by mail id,\n *    and only new nodes are inserted. The list is never re-rendered whole.\n */\n(function () {\n  var LS_ADDR = 'tm_v2_address';\n  var LS_TOKEN = 'tm_v2_token';\n\n  function $(id) {\n    try { return document.getElementById(id); } catch (e) { return null; }\n  }\n\n  var els = {\n    name: $('name'),\n    domain: $('domain'),\n    createBtn: $('createBtn'),\n    randomBtn: $('randomBtn'),\n    addr: $('addr'),\n    token: $('token'),\n    copyAddr: $('copyAddr'),\n    inbox: $('inbox'),\n    view: $('view'),\n    search: $('search'),\n    refreshBtn: $('refreshBtn'),\n    status: $('status')\n  };\n\n  // ---------- state ----------\n  var address = '';\n  var authToken = '';\n  var maxId = 0;                 // highest mail id seen (the since_id cursor)\n  var nodesById = new Map();     // mail id -> list DOM node\n  var mailById = new Map();      // mail id -> list-level mail object\n  var generation = 0;            // bumped on inbox switch; kills stale loops\n  var waitAbort = null;          // AbortController for the in-flight /api/wait\n  var fallbackTimer = null;      // setInterval id when in 3s-polling fallback\n  var mode = 'idle';             // 'wait' | 'fallback' | 'paused' | 'idle'\n  var emptyNode = null;          // \"no mails yet\" placeholder node\n  var selectedId = null;\n\n  // ---------- helpers ----------\n  function esc(s) {\n    return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) {\n      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c];\n    });\n  }\n\n  function setStatus(text) {\n    if (els.status) els.status.textContent = text;\n  }\n\n  function relTime(createdAtSec) {\n    var sec = Math.floor(Date.now() / 1000) - Number(createdAtSec || 0);\n    if (!createdAtSec || sec < 0) return '';\n    if (sec < 10) return 'just now';\n    if (sec < 60) return sec + 's ago';\n    var min = Math.floor(sec / 60);\n    if (min < 60) return min + 'm ago';\n    var hr = Math.floor(min / 60);\n    if (hr < 24) return hr + 'h ago';\n    var day = Math.floor(hr / 24);\n    if (day < 30) return day + 'd ago';\n    return new Date(Number(createdAtSec) * 1000).toLocaleDateString();\n  }\n\n  function copyText(text, btn) {\n    if (!text) return Promise.resolve(false);\n    function done(ok) {\n      if (btn) {\n        var old = btn.textContent;\n        btn.textContent = ok ? 'Copied!' : 'Copy failed';\n        setTimeout(function () { btn.textContent = old; }, 1200);\n      }\n      return ok;\n    }\n    if (navigator.clipboard && navigator.clipboard.writeText) {\n      return navigator.clipboard.writeText(text).then(function () { return done(true); },\n        function () { return fallbackCopy(text, btn, done); });\n    }\n    return Promise.resolve(fallbackCopy(text, btn, done));\n  }\n\n  function fallbackCopy(text, btn, done) {\n    try {\n      var ta = document.createElement('textarea');\n      ta.value = text;\n      ta.setAttribute('readonly', '');\n      ta.style.position = 'fixed';\n      ta.style.opacity = '0';\n      document.body.appendChild(ta);\n      ta.select();\n      var ok = document.execCommand('copy');\n      document.body.removeChild(ta);\n      return done(ok);\n    } catch (e) { return done(false); }\n  }\n\n  function authHeaders() {\n    return { Authorization: 'Bearer ' + authToken };\n  }\n\n  function normalizeList(payload) {\n    if (!payload) return [];\n    if (Array.isArray(payload)) return payload;\n    if (Array.isArray(payload.results)) return payload.results;\n    if (Array.isArray(payload.mails)) return payload.mails;\n    if (Array.isArray(payload.new)) return payload.new;\n    if (payload.mail) return [payload.mail];\n    if (payload.id) return [payload];\n    return [];\n  }\n\n  // ---------- incremental list rendering ----------\n  function ensureEmptyNode() {\n    if (!els.inbox) return;\n    if (nodesById.size === 0) {\n      if (!emptyNode) {\n        emptyNode = document.createElement('div');\n        emptyNode.className = 'empty';\n        emptyNode.textContent = address\n          ? 'No mails yet - send a mail to ' + address\n          : 'Create an inbox first';\n        els.inbox.appendChild(emptyNode);\n      }\n    } else if (emptyNode) {\n      emptyNode.remove();\n      emptyNode = null;\n    }\n  }\n\n  function matchesSearch(mail) {\n    if (!els.search || !els.search.value) return true;\n    var q = els.search.value.trim().toLowerCase();\n    if (!q) return true;\n    var hay = ((mail.subject || '') + ' ' + (mail.sender || '') + ' ' +\n      (mail.preview || '') + ' ' + (mail.text_body || '')).toLowerCase();\n    return hay.indexOf(q) !== -1;\n  }\n\n  function buildMailNode(mail) {\n    var node = document.createElement('div');\n    node.className = 'mail';\n    node.dataset.id = String(mail.id);\n\n    var subj = document.createElement('b');\n    subj.textContent = mail.subject || '(no subject)';\n    node.appendChild(subj);\n    node.appendChild(document.createElement('br'));\n\n    var meta = document.createElement('small');\n    var from = document.createElement('span');\n    from.textContent = mail.sender || '';\n    var when = document.createElement('span');\n    when.className = 'mail-time';\n    when.dataset.created = String(mail.created_at || '');\n    when.textContent = mail.created_at ? ' - ' + relTime(mail.created_at) : '';\n    meta.appendChild(from);\n    meta.appendChild(when);\n    node.appendChild(meta);\n\n    if (mail.preview) {\n      node.appendChild(document.createElement('br'));\n      var prev = document.createElement('small');\n      prev.textContent = mail.preview;\n      node.appendChild(prev);\n    }\n\n    node.addEventListener('click', function () { viewMail(mail.id); });\n    return node;\n  }\n\n  // Insert keeping newest-first order, without touching existing nodes.\n  function insertNode(node, id) {\n    if (!els.inbox) return;\n    var before = null;\n    var children = els.inbox.children;\n    for (var i = 0; i < children.length; i++) {\n      var cid = Number(children[i].dataset && children[i].dataset.id);\n      if (cid && cid < id) { before = children[i]; break; }\n    }\n    if (before) els.inbox.insertBefore(node, before);\n    else els.inbox.appendChild(node);\n  }\n\n  // Add only mails whose id we have never seen. Returns count added.\n  function addMails(list) {\n    var added = 0;\n    // Oldest first so insertion order settles newest-first at the top.\n    var sorted = list.slice().sort(function (a, b) { return Number(a.id) - Number(b.id); });\n    for (var i = 0; i < sorted.length; i++) {\n      var mail = sorted[i];\n      var id = Number(mail && mail.id);\n      if (!id || nodesById.has(id)) continue;\n      mailById.set(id, mail);\n      if (id > maxId) maxId = id;\n      var node = buildMailNode(mail);\n      if (!matchesSearch(mail)) node.style.display = 'none';\n      nodesById.set(id, node);\n      insertNode(node, id);\n      added++;\n    }\n    if (added) ensureEmptyNode();\n    return added;\n  }\n\n  function applySearch() {\n    nodesById.forEach(function (node, id) {\n      var mail = mailById.get(id) || {};\n      node.style.display = matchesSearch(mail) ? '' : 'none';\n    });\n  }\n\n  function clearInboxList() {\n    nodesById.forEach(function (node) { node.remove(); });\n    nodesById.clear();\n    mailById.clear();\n    maxId = 0;\n    selectedId = null;\n    if (emptyNode) { emptyNode.remove(); emptyNode = null; }\n    ensureEmptyNode();\n  }\n\n  function refreshTimestamps() {\n    if (!els.inbox) return;\n    var times = els.inbox.querySelectorAll('.mail-time');\n    for (var i = 0; i < times.length; i++) {\n      var created = Number(times[i].dataset.created);\n      if (created) times[i].textContent = ' - ' + relTime(created);\n    }\n  }\n\n  // ---------- API ----------\n  function loadMails() {\n    if (!authToken) return Promise.resolve(0);\n    var gen = generation;\n    return fetch('/api/mails?limit=50&offset=0', { headers: authHeaders() })\n      .then(function (r) {\n        if (!r.ok) throw new Error('mails ' + r.status);\n        return r.json();\n      })\n      .then(function (j) {\n        if (gen !== generation) return 0; // inbox switched meanwhile\n        var added = addMails(normalizeList(j));\n        ensureEmptyNode();\n        return added;\n      })\n      .catch(function () {\n        if (gen === generation) setStatus('Could not load inbox - retrying…');\n        return 0;\n      });\n  }\n\n  // ---------- live updates: long-poll with polling fallback ----------\n  function stopLive() {\n    if (waitAbort) { try { waitAbort.abort(); } catch (e) {} waitAbort = null; }\n    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }\n  }\n\n  function startFallback(gen) {\n    if (gen !== generation || mode === 'fallback') return;\n    mode = 'fallback';\n    stopLive();\n    setStatus('Live unavailable - refreshing every 3s');\n    fallbackTimer = setInterval(function () {\n      if (gen !== generation || document.hidden) return;\n      loadMails();\n    }, 3000);\n  }\n\n  function startWaitLoop() {\n    if (!authToken || document.hidden) return;\n    var gen = generation;\n    mode = 'wait';\n    setStatus('Live - waiting for new mail…');\n\n    function step() {\n      if (gen !== generation || document.hidden || mode !== 'wait') return;\n      waitAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;\n      var opts = { headers: authHeaders() };\n      if (waitAbort) opts.signal = waitAbort.signal;\n      fetch('/api/wait?since_id=' + encodeURIComponent(maxId), opts)\n        .then(function (r) {\n          if (!r.ok) throw new Error('wait ' + r.status);\n          return r.json();\n        })\n        .then(function (j) {\n          if (gen !== generation || mode !== 'wait') return;\n          var list = normalizeList(j);\n          if (j && (j.since_id || j.last_id)) {\n            var cursor = Number(j.since_id || j.last_id);\n            if (cursor > maxId && list.length === 0) maxId = cursor;\n          }\n          if (list.length) {\n            var added = addMails(list);\n            if (added) setStatus('New mail received');\n            setTimeout(function () { if (mode === 'wait') setStatus('Live - waiting for new mail…'); }, 2000);\n          }\n          step(); // long-poll again immediately (also after a 25s timeout reply)\n        })\n        .catch(function (err) {\n          if (gen !== generation) return;\n          if (err && err.name === 'AbortError') return; // switch / pause: not an error\n          if (document.hidden) return;\n          startFallback(gen); // /api/wait errored -> 3s polling\n        });\n    }\n    step();\n  }\n\n  function startLive() {\n    stopLive();\n    if (!authToken) { mode = 'idle'; return; }\n    if (document.hidden) { mode = 'paused'; setStatus('Paused (tab hidden)'); return; }\n    startWaitLoop();\n  }\n\n  // ---------- inbox create / switch ----------\n  function setInbox(newAddress, newToken, persist) {\n    generation++;            // invalidate any in-flight loop/fetch\n    stopLive();\n    mode = 'idle';\n    address = newAddress || '';\n    authToken = newToken || '';\n    if (persist) {\n      try {\n        localStorage.setItem(LS_ADDR, address);\n        localStorage.setItem(LS_TOKEN, authToken);\n      } catch (e) {}\n    }\n    if (els.addr) els.addr.textContent = address || '-';\n    if (els.token) els.token.textContent = authToken || '-';\n    clearInboxList();\n    if (els.view) els.view.textContent = 'Click a mail to view it';\n  }\n\n  function createInbox(random) {\n    var gen = generation + 1;\n    var nameVal = (!random && els.name) ? els.name.value.trim() : '';\n    var domainVal = (els.domain && els.domain.value) || undefined;\n    setStatus('Creating inbox…');\n    return fetch('/api/new_address', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({\n        name: nameVal ? nameVal : undefined,\n        domain: domainVal\n      })\n    })\n      .then(function (r) { return r.json(); })\n      .then(function (j) {\n        if (!j || j.error || !j.address) {\n          setStatus((j && j.error) || 'Could not create inbox');\n          return;\n        }\n        if (random && els.name) els.name.value = '';\n        setInbox(j.address, j.token || j.jwt || '', true);\n        if (gen !== generation) return; // superseded (defensive)\n        setStatus('Inbox ready - loading…');\n        return loadMails().then(function () { startLive(); });\n      })\n      .catch(function () { setStatus('Network error creating inbox'); });\n  }\n\n  // ---------- mail viewing ----------\n  // Escaped body with the OTP digits wrapped in <mark>. Escaping happens\n  // first; the OTP is digits-only, so wrapping it afterwards cannot\n  // re-introduce markup from the mail content.\n  function highlightedBody(mail) {\n    var body = esc(mail.text_body || mail.preview || '');\n    var otpVal = mail.otp ? String(mail.otp) : null;\n    if (!otpVal) {\n      var m = body.match(/\\b\\d{4,8}\\b/);\n      if (m) otpVal = m[0];\n    }\n    if (otpVal) {\n      body = body.split(esc(otpVal)).join('<mark>' + esc(otpVal) + '</mark>');\n    }\n    return { html: body, otp: otpVal };\n  }\n\n  function viewMail(id) {\n    if (!els.view) return;\n    selectedId = id;\n    nodesById.forEach(function (node, nid) {\n      node.classList.toggle('active', nid === id);\n    });\n    els.view.textContent = 'Loading…';\n    fetch('/api/mail/' + encodeURIComponent(id), { headers: authHeaders() })\n      .then(function (r) {\n        if (!r.ok) throw new Error('mail ' + r.status);\n        return r.json();\n      })\n      .then(function (mail) {\n        if (selectedId !== id || !els.view) return;\n        // Keep the cached list entry fresh for search.\n        if (mail && mail.id) mailById.set(Number(mail.id), Object.assign({}, mailById.get(Number(mail.id)) || {}, mail));\n        els.view.textContent = '';\n\n        var title = document.createElement('h4');\n        title.textContent = mail.subject || '(no subject)';\n        els.view.appendChild(title);\n\n        var from = document.createElement('p');\n        var fromSmall = document.createElement('small');\n        fromSmall.textContent = 'From: ' + (mail.sender || '') +\n          (mail.created_at ? ' - ' + relTime(mail.created_at) + ' (' +\n            new Date(Number(mail.created_at) * 1000).toLocaleString() + ')' : '');\n        from.appendChild(fromSmall);\n        els.view.appendChild(from);\n\n        var result = highlightedBody(mail || {});\n        if (result.otp) {\n          var otpRow = document.createElement('p');\n          var otpLabel = document.createElement('span');\n          otpLabel.textContent = 'OTP: ';\n          var otpValEl = document.createElement('strong');\n          otpValEl.textContent = result.otp;\n          var otpBtn = document.createElement('button');\n          otpBtn.type = 'button';\n          otpBtn.textContent = 'Copy OTP';\n          otpBtn.addEventListener('click', function () { copyText(result.otp, otpBtn); });\n          otpRow.appendChild(otpLabel);\n          otpRow.appendChild(otpValEl);\n          otpRow.appendChild(document.createTextNode(' '));\n          otpRow.appendChild(otpBtn);\n          els.view.appendChild(otpRow);\n        }\n\n        var pre = document.createElement('pre');\n        pre.style.whiteSpace = 'pre-wrap';\n        pre.style.wordBreak = 'break-word';\n        pre.innerHTML = result.html; // already escaped above; only <mark> was added\n        els.view.appendChild(pre);\n      })\n      .catch(function () {\n        if (selectedId === id && els.view) els.view.textContent = 'Could not load this mail';\n      });\n  }\n\n  // ---------- init ----------\n  function initDomains() {\n    if (!els.domain) return Promise.resolve();\n    return fetch('/api/config')\n      .then(function (r) { return r.json(); })\n      .then(function (j) {\n        var list = (j && j.domains) || [];\n        els.domain.textContent = '';\n        list.forEach(function (d) {\n          var opt = document.createElement('option');\n          opt.value = d;\n          opt.textContent = d;\n          els.domain.appendChild(opt);\n        });\n      })\n      .catch(function () { setStatus('Could not load configuration'); });\n  }\n\n  function restoreInbox() {\n    var savedAddr = null, savedToken = null;\n    try {\n      savedAddr = localStorage.getItem(LS_ADDR);\n      savedToken = localStorage.getItem(LS_TOKEN);\n    } catch (e) {}\n    if (savedAddr && savedToken) {\n      setInbox(savedAddr, savedToken, false);\n      setStatus('Inbox restored - loading…');\n      loadMails().then(function () { startLive(); });\n    } else {\n      ensureEmptyNode();\n      setStatus('Create an inbox to start');\n    }\n  }\n\n  function bind() {\n    if (els.createBtn) els.createBtn.addEventListener('click', function () { createInbox(false); });\n    if (els.randomBtn) els.randomBtn.addEventListener('click', function () { createInbox(true); });\n    if (els.refreshBtn) els.refreshBtn.addEventListener('click', function () {\n      if (!authToken) return;\n      setStatus('Refreshing…');\n      loadMails().then(function () { if (mode === 'wait' || mode === 'idle') setStatus('Live - waiting for new mail…'); });\n    });\n    if (els.copyAddr) els.copyAddr.addEventListener('click', function () { copyText(address, els.copyAddr); });\n    if (els.search) els.search.addEventListener('input', applySearch);\n    if (els.name) els.name.addEventListener('keydown', function (e) {\n      if (e.key === 'Enter') createInbox(false);\n    });\n\n    document.addEventListener('visibilitychange', function () {\n      if (!authToken) return;\n      if (document.hidden) {\n        stopLive(); // aborts the in-flight /api/wait; its AbortError is ignored\n        mode = 'paused';\n        setStatus('Paused (tab hidden)');\n      } else {\n        setStatus('Back - checking for new mail…');\n        loadMails().then(function () { startLive(); });\n      }\n    });\n\n    setInterval(refreshTimestamps, 30000);\n  }\n\n  function init() {\n    bind();\n    initDomains().then(restoreInbox);\n  }\n\n  if (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', init);\n  } else {\n    init();\n  }\n})();\n\n</script>\n</body>\n</html>\n";

// ---------------------------------------------------------------------------
// Pagination + auth helpers
// ---------------------------------------------------------------------------
function parsePagination(url) {
  const limit = Math.min(Math.max(intParam(url, "limit", 20), 1), 50);
  const offset = Math.max(intParam(url, "offset", 0), 0);
  const beforeRaw = url.searchParams.get("before_id");
  const sinceRaw = url.searchParams.get("since_id");
  return {
    limit, offset,
    before_id: beforeRaw !== null && Number.isFinite(parseInt(beforeRaw, 10)) ? parseInt(beforeRaw, 10) : null,
    since_id: sinceRaw !== null && Number.isFinite(parseInt(sinceRaw, 10)) ? parseInt(sinceRaw, 10) : null,
  };
}
function pageMeta(results, limit) {
  const ids = results.map(r => r.id);
  return {
    count: results.length,
    next_before_id: results.length ? results[results.length - 1].id : null,
    has_more: results.length === limit,
    latest_id: ids.length ? Math.max(...ids) : null,
  };
}
// Build a paged mails query for one address. Columns are fixed strings only;
// all values are bound parameters.
function mailsQuery(address, pg, columns) {
  let sql = "SELECT " + columns + " FROM mails WHERE address=?";
  const binds = [address];
  if (pg.since_id !== null) { sql += " AND id>?"; binds.push(pg.since_id); }
  if (pg.before_id !== null) { sql += " AND id<?"; binds.push(pg.before_id); }
  sql += " ORDER BY id DESC LIMIT ? OFFSET ?";
  binds.push(pg.limit, pg.offset);
  return { sql, binds };
}
async function resolveAddress(env, request, url) {
  const auth = request.headers.get("Authorization") || "";
  const tok = auth.replace("Bearer ", "") || url.searchParams.get("token") || "";
  if (tok) {
    const row = await env.DB.prepare("SELECT address FROM addresses WHERE token=?").bind(tok).first();
    return row ? row.address : null;
  }
  const addr = url.searchParams.get("address");
  return addr ? decodeURIComponent(addr).toLowerCase() : null;
}


// ---------------------------------------------------------------------------
// INLINED from webhooks.js (single-file deploy: no ES imports resolve in the
// live API upload, so this code is copied verbatim, minus its
// `export default deliverWebhook` — the Worker's default export below wins).
// HMAC webhook delivery: https only, X-TempMail-Signature = hex HMAC-SHA256
// of the exact raw body when WEBHOOK_SECRET is set, 5s timeout, never throws.
// Vars: WEBHOOK_URL (unset = no-op), WEBHOOK_SECRET (unset = unsigned).
// ---------------------------------------------------------------------------
const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Validate a candidate webhook URL. https only.
 * @param {unknown} url
 * @returns {boolean} true iff `url` is a string that parses as a URL with
 *   an "https:" protocol. Never throws.
 */
export function validateWebhookUrl(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * HMAC-SHA256 signature of a payload, as lowercase hex.
 * Uses WebCrypto (globalThis.crypto.subtle), available in Workers and
 * Node 19+. The signature covers the EXACT body string that will be sent —
 * sign the serialized JSON once and send those same bytes.
 * @param {string} secret  Shared secret. Falsy -> returns "" (unsigned).
 * @param {string} bodyString  Raw request body to sign.
 * @returns {Promise<string>} 64-char hex digest, or "" if no secret.
 */
export async function signPayload(secret, bodyString) {
  if (!secret) return "";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(String(bodyString ?? "")));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deliver one mail event to env.WEBHOOK_URL. NEVER throws.
 * @param {object} env  Worker env; reads WEBHOOK_URL and WEBHOOK_SECRET.
 * @param {string|object} [event]  Event name (default "mail.received");
 *   an object with an `.address` is also accepted as an address fallback.
 * @param {object} mail  Stored mail record. Used fields: address/to,
 *   id, sender/from, subject, otp, created_at. Extra fields are NOT sent —
 *   the wire mail object is exactly {id, sender, subject, otp, created_at}.
 * @returns {Promise<{delivered: boolean, status?: number}>}
 *   {delivered:true, status} only on a 2xx response; {delivered:false}
 *   (plus `status` when a response was received) for no URL, an invalid
 *   URL, a non-2xx response, a timeout, or any other failure.
 */
export async function deliverWebhook(env, event, mail) {
  try {
    const url = env?.WEBHOOK_URL;
    if (!url) return { delivered: false };
    if (!validateWebhookUrl(url)) {
      console.error("webhook: WEBHOOK_URL is not a valid https URL; delivery skipped");
      return { delivered: false };
    }

    const m = mail || {};
    const eventName = typeof event === "string" && event ? event : "mail.received";
    const address =
      m.address || m.to ||
      (event && typeof event === "object" ? event.address : null) ||
      null;

    const payload = {
      event: eventName,
      address,
      mail: {
        id: m.id ?? null,
        sender: m.sender || m.from || null,
        subject: m.subject ?? null,
        otp: m.otp ?? null,
        created_at: m.created_at ?? null,
      },
    };

    // Serialize once: these exact bytes are both signed and sent.
    const body = JSON.stringify(payload);
    const headers = { "Content-Type": "application/json" };
    const signature = await signPayload(env?.WEBHOOK_SECRET, body);
    if (signature) headers["X-TempMail-Signature"] = signature;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return { delivered: true, status: res.status };
    console.error(`webhook: delivery to ${address} failed with status ${res.status}`);
    return { delivered: false, status: res.status };
  } catch (e) {
    // Timeout (AbortError), network error, bad env, signing failure — all
    // land here. Log only the error name/message, never body/secret.
    console.error(`webhook: delivery failed: ${e?.name || "Error"}: ${e?.message || e}`);
    return { delivered: false };
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url); const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/") return new Response(UI_HTML, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "public, max-age=60" } });
    if (path === "/api/health") return json({ ok: true, service: "temp-mail", version: 2, domain: domains(env), time: new Date().toISOString() });
    if (path === "/api/config" || path === "/api/domains") return json({ domains: domains(env), ttl_hours: parseInt(env.MAIL_TTL_HOURS || "24") });

    if (path === "/api/new_address" && request.method === "POST") {
      const rlCreate = createInboxLimiter.check(getClientKey(request));
      if (!rlCreate.allowed) return rateLimitResponse(rlCreate);
      let body = {}; try { body = await request.json(); } catch {}
      const ds = domains(env); const domain = (body.domain || ds[0]).toLowerCase();
      if (!ds.includes(domain)) return jsonNoStore({ error: "Invalid domain", allowed: ds }, 400);
      const name = (body.name || rnd(10)).toLowerCase().replace(/[^a-z0-9._-]/g, "");
      if (!name) return jsonNoStore({ error: "Invalid name" }, 400);
      const address = name + "@" + domain; const tok = token();
      const exp = Math.floor(Date.now() / 1000) + parseInt(env.MAIL_TTL_HOURS || "24") * 3600;
      try { await env.DB.prepare("INSERT INTO addresses (address,token,expires_at) VALUES (?,?,?)").bind(address, tok, exp).run(); }
      catch (e) {
        if (String(e).includes("UNIQUE")) { const row = await env.DB.prepare("SELECT token FROM addresses WHERE address=?").bind(address).first(); return jsonNoStore({ address, token: row?.token, reused: true }); }
        throw e;
      }
      return jsonNoStore({ address, token: tok, jwt: tok, expires_at: exp });
    }

    // (a) Long-poll: GET /api/wait?token=... | ?address=... [&since_id=N]
    if (path === "/api/wait" && request.method === "GET") {
      const waitKey = (request.headers.get("Authorization") || "").replace("Bearer ", "") || url.searchParams.get("token") || url.searchParams.get("address") || "";
      if (waitKey) { const rlWait = waitLimiter.check("wait:" + waitKey); if (!rlWait.allowed) return rateLimitResponse(rlWait); }
      const address = await resolveAddress(env, request, url);
      if (!address) return jsonNoStore({ error: "Unauthorized - provide token or address" }, 401);
      const since_id = Math.max(intParam(url, "since_id", 0), 0);
      const limit = Math.min(Math.max(intParam(url, "limit", 20), 1), 50);
      const waitS = Math.min(Math.max(intParam(url, "timeout", 25), 1), 30);
      const deadline = Date.now() + waitS * 1000;
      const pollMs = 1200;
      for (;;) {
        const { results } = await env.DB.prepare(
          "SELECT id,address,sender,subject,text_body,html_body,created_at FROM mails WHERE address=? AND id>? ORDER BY id DESC LIMIT ?"
        ).bind(address, since_id, limit).all();
        if (results.length) {
          const enriched = results.map(r => enrichMail(r, true));
          return jsonNoStore({ timeout: false, address, since_id, latest_id: Math.max(...results.map(r => r.id)), count: enriched.length, results: enriched });
        }
        if (Date.now() >= deadline) return jsonNoStore({ timeout: true, address, since_id, results: [] });
        await sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
      }
    }

    if (path === "/api/mails" && request.method === "GET") {
      const auth = request.headers.get("Authorization") || "";
      const tok = auth.replace("Bearer ", "") || url.searchParams.get("token") || "";
      if (!tok) return json({ error: "Unauthorized" }, 401);
      const rlMails = mailsReadLimiter.check("mails:" + tok);
      if (!rlMails.allowed) return rateLimitResponse(rlMails);
      const row = await env.DB.prepare("SELECT address FROM addresses WHERE token=?").bind(tok).first();
      if (!row) return json({ error: "Unauthorized" }, 401);
      const pg = parsePagination(url);
      const q = mailsQuery(row.address, pg, "id,address,sender,subject,substr(text_body,1,200) as preview,created_at");
      const { results } = await env.DB.prepare(q.sql).bind(...q.binds).all();
      const enriched = results.map(r => enrichMail(r, false));
      return listJson(request, { address: row.address, ...pageMeta(results, pg.limit), since_id: pg.since_id, before_id: pg.before_id, results: enriched });
    }

    const inboxMatch = path.match(/^\/api\/inboxes\/(.+)\/messages$/);
    if (inboxMatch && request.method === "GET") {
      const address = decodeURIComponent(inboxMatch[1]).toLowerCase();
      // AUTH (SEC-01 fix): the Bearer token must own this address.
      const tokI = (request.headers.get("Authorization") || "").replace("Bearer ", "") || url.searchParams.get("token") || "";
      if (!tokI) return json({ error: "Unauthorized" }, 401);
      const ownerI = await env.DB.prepare("SELECT address FROM addresses WHERE token=?").bind(tokI).first();
      if (!ownerI || ownerI.address !== address) return json({ error: "Unauthorized" }, 401);
      const pg = parsePagination(url);
      const q = mailsQuery(address, pg, "id,address,sender,subject,text_body,html_body,created_at");
      const { results } = await env.DB.prepare(q.sql).bind(...q.binds).all();
      const enriched = results.map(r => enrichMail(r, true));
      return listJson(request, { address, ...pageMeta(results, pg.limit), since_id: pg.since_id, before_id: pg.before_id, results: enriched });
    }

    const mailMatch = path.match(/^\/api\/mail\/(\d+)$/);
    if (mailMatch && (request.method === "GET" || request.method === "DELETE")) {
      // AUTH (SEC-02 fix): Bearer token required and must own the mail's
      // inbox. Missing token -> 401; foreign/missing mail -> 404 (no leak).
      const tokM = (request.headers.get("Authorization") || "").replace("Bearer ", "") || url.searchParams.get("token") || "";
      if (!tokM) return json({ error: "Unauthorized" }, 401);
      const ownerM = await env.DB.prepare("SELECT address FROM addresses WHERE token=?").bind(tokM).first();
      if (!ownerM) return json({ error: "Unauthorized" }, 401);
      const row = await env.DB.prepare("SELECT * FROM mails WHERE id=?").bind(mailMatch[1]).first();
      if (!row || row.address !== ownerM.address) return json({ error: "Not found" }, 404);
      if (request.method === "GET") {
        return json(enrichMail(row, true), 200, { "Cache-Control": "private, max-age=2" });
      }
      await env.DB.prepare("DELETE FROM mails WHERE id=? AND address=?").bind(mailMatch[1], ownerM.address).run();
      return jsonNoStore({ ok: true });
    }
    return json({ error: "Not found", path }, 404);
  },

  async email(message, env, ctx) {
    const to = message.to.toLowerCase();
    try {
      const rawText = await new Response(message.raw).text();
      const parsed = parseRaw(rawText); // RUST_WASM_HOOK: sole raw-MIME entry point
      const existing = await env.DB.prepare("SELECT address FROM addresses WHERE address=?").bind(to).first();
      if (!existing) await env.DB.prepare("INSERT OR IGNORE INTO addresses (address,token) VALUES (?,?)").bind(to, token()).run();
      const insertRes = await env.DB.prepare("INSERT INTO mails (address,sender,subject,text_body,html_body,raw_size) VALUES (?,?,?,?,?,?)").bind(to, message.from || parsed.from, parsed.subject, parsed.text, parsed.html, rawText.length).run();
      // INLINED webhook: fire-and-forget via ctx.waitUntil when WEBHOOK_URL
      // is set. deliverWebhook() never throws and is a no-op without a URL,
      // so this can never fail or delay the mail insert above.
      if (env.WEBHOOK_URL) {
        const mail = {
          id: insertRes.meta?.last_row_id ?? null,
          address: to,
          sender: message.from || parsed.from,
          subject: parsed.subject,
          otp: extractOTP(parsed.text + " " + parsed.subject),
          created_at: Math.floor(Date.now() / 1000),
        };
        try { ctx.waitUntil(deliverWebhook(env, "mail.received", mail)); }
        catch { void deliverWebhook(env, "mail.received", mail); }
      }
    } catch (e) {
      console.error("email failed", e);
      await env.DB.prepare("INSERT INTO mails (address,sender,subject,text_body) VALUES (?,?,?,?)").bind(to, message.from, "(parse failed)", "").run();
    }
  },

  async scheduled(event, env, ctx) {
    const ttl = parseInt(env.MAIL_TTL_HOURS || "24"); const cutoff = Math.floor(Date.now() / 1000) - ttl * 3600;
    ctx.waitUntil(Promise.all([
      env.DB.prepare("DELETE FROM mails WHERE created_at < ?").bind(cutoff).run(),
      env.DB.prepare("DELETE FROM addresses WHERE expires_at IS NOT NULL AND expires_at < ?").bind(Math.floor(Date.now() / 1000)).run(),
    ]));
  },
};
