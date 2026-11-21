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
export const UI_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temp Mail - turjaun.xyz</title><style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px;background:#0f172a;color:#e2e8f0}input,button,select{padding:10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#fff}button{background:#2563eb;cursor:pointer;border:none}.card{background:#1e293b;padding:16px;border-radius:12px;margin:12px 0}.mail{border-top:1px solid #334155;padding:12px 0;cursor:pointer}small{color:#94a3b8}</style></head><body><h1>Temp Mail — turjaun.xyz</h1><div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap"><input id="name" placeholder="custom name (optional)" style="flex:1"><select id="domain"></select><button onclick="createAddr()">Create</button><button onclick="randomAddr()">Random</button></div><p>Address: <b id="addr">-</b></p><p><small>Token: <span id="token">-</span></small></p><button onclick="loadMails()">Refresh</button></div><div class="card"><h3>Inbox</h3><div id="inbox">Create inbox first</div></div><div class="card"><h3>Message</h3><pre id="view" style="white-space:pre-wrap;word-break:break-word">Click a mail</pre></div><script>let A='',T='',lastId=0;async function init(){let r=await fetch('/api/config');let j=await r.json();document.getElementById('domain').innerHTML=j.domains.map(d=>'<option>'+d+'</option>').join('')}async function createAddr(){let n=document.getElementById('name').value,d=document.getElementById('domain').value;let r=await fetch('/api/new_address',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n||undefined,domain:d})});let j=await r.json();if(j.error){alert(j.error);return}A=j.address;T=j.token;document.getElementById('addr').textContent=A;document.getElementById('token').textContent=T;localStorage.setItem('a',A);localStorage.setItem('t',T);loadMails()}async function randomAddr(){document.getElementById('name').value='';await createAddr()}async function loadMails(){if(!T)return;let r=await fetch('/api/mails?limit=20',{headers:{Authorization:'Bearer '+T}});let j=await r.json();let el=document.getElementById('inbox');if(!j.results?.length){el.innerHTML='No mails yet — send to '+A;return}lastId=j.results[0].id;el.innerHTML=j.results.map(m=>'<div class="mail" onclick="viewMail('+m.id+')"><b>'+esc(m.subject||'')+'</b><br><small>'+esc(m.sender||'')+'</small></div>').join('');waitLoop()}async function waitLoop(){if(!T)return;try{let r=await fetch('/api/wait?since_id='+lastId,{headers:{Authorization:'Bearer '+T}});let j=await r.json();if(!j.timeout&&j.results?.length){loadMails()}else if(T){waitLoop()}}catch(e){setTimeout(waitLoop,3000)}}async function viewMail(id){let r=await fetch('/api/mail/'+id);let j=await r.json();document.getElementById('view').textContent=j.subject+' From: '+j.sender+' OTP: '+(j.otp||'-')+' Links: '+((j.verification_links||[]).join(' '))+' '+(j.text_body||'')}function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}init();let sa=localStorage.getItem('a'),st=localStorage.getItem('t');if(sa&&st){A=sa;T=st;document.getElementById('addr').textContent=sa;document.getElementById('token').textContent=st;loadMails()}</script></body></html>`;

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
      const deadline = Date.now() + 25000;
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
      const pg = parsePagination(url);
      const q = mailsQuery(address, pg, "id,address,sender,subject,text_body,html_body,created_at");
      const { results } = await env.DB.prepare(q.sql).bind(...q.binds).all();
      const enriched = results.map(r => enrichMail(r, true));
      return listJson(request, { address, ...pageMeta(results, pg.limit), since_id: pg.since_id, before_id: pg.before_id, results: enriched });
    }

    const mailMatch = path.match(/^\/api\/mail\/(\d+)$/);
    if (mailMatch && request.method === "GET") {
      const row = await env.DB.prepare("SELECT * FROM mails WHERE id=?").bind(mailMatch[1]).first();
      if (!row) return json({ error: "Not found" }, 404);
      return json(enrichMail(row, true), 200, { "Cache-Control": "private, max-age=2" });
    }
    if (mailMatch && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM mails WHERE id=?").bind(mailMatch[1]).run();
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
