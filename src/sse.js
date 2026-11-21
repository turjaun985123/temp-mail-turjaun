// sse.js — Server-Sent Events (SSE) alternative to GET /api/wait
// Temp Mail v2, turjaun.xyz — zero dependencies, ESM, Cloudflare Workers.
//
// ---------------------------------------------------------------------------
// HONEST COMPARISON: SSE (this module) vs /api/wait (worker-v2.js) — READ THIS
// ---------------------------------------------------------------------------
// Both mechanisms do the SAME thing under the hood on Cloudflare Workers:
// there is no push primitive available to this Worker — no Durable Object
// alarm, Queue consumer, or WebSocket is wired to the email() handler in
// v2 — so both /api/wait and this SSE stream discover new mail by
// POLLING D1 on an interval (/api/wait: ~1.2 s for up to 25 s; SSE here:
// 2 s for up to 55 s). SSE does not make mail arrive faster; it only
// changes the delivery shape from "one JSON response per wait cycle" to
// "many events over one open response". First-mail latency is therefore
// comparable (bounded by the D1 poll interval), not better.
//
// Where SSE is WORSE on Cloudflare Workers — the reasons it is NOT the
// default:
//  * Billing / duration: a held-open Worker request accrues wall-clock
//    duration for its entire lifetime. A 55 s SSE connection costs ~55 s
//    of request duration to deliver what a /api/wait cycle usually
//    resolves in one short burst — and a busy SSE client reconnects and
//    pays it again, indefinitely. /api/wait is capped at 25 s and, more
//    importantly, ENDS: idle clients hold nothing between cycles.
//    (Exact charging depends on the Workers plan / CPU-vs-duration
//    model in force; the direction — longer open = more cost — does not.)
//  * Connection limits: every open SSE stream occupies one concurrent
//    connection to the Worker / to the client origin for its whole life.
//    Platforms, browsers (famously ~6 connections per host for HTTP/1.1
//    EventSource), and proxies all cap concurrent connections, so many
//    open inboxes = many pinned connections, and a browser tab can starve
//    its own other requests. /api/wait holds a connection only while
//    waiting and frees it on every response.
//  * Intermediaries: some proxies / CDNs buffer or idle-timeout long-lived
//    responses despite `Cache-Control: no-store` and heartbeat pings;
//    a buffered SSE stream silently degrades to "nothing, then a burst".
//    A plain JSON long-poll response has no such failure mode.
//  * Client support: EventSource cannot set an `Authorization` header,
//    so SSE clients must use the address-as-capability URL form (or a
//    `?token=` query parameter, which leaks into logs/history — see
//    docs/API.md, Authentication). /api/wait takes a proper Bearer header.
//
// Where SSE is genuinely better:
//  * Multiple mails arriving over time arrive as separate `mail` events
//    on one connection — no client code to loop wait cycles, advance a
//    cursor, and re-connect between each message.
//  * Browser-native auto-reconnect (EventSource) plus the `reconnect`
//    event emitted here gives a fairly hands-off live-inbox UI feed.
//
// RECOMMENDATION: use GET /api/wait as the default — it is the documented,
// supported wait mechanism (docs/API.md, AGENTS.md §2 Step 4: one request
// per cycle, never parallel waits for one inbox). Treat SSE as OPT-IN,
// for live UI feeds that truly need a continuous event stream and accept
// the duration/connection costs above. Do not run SSE and /api/wait for
// the same inbox at the same time, and do not open more than one SSE
// stream per inbox per client.
//
// Integration (done by the integrator in worker-v2.js, not in this file):
//   import { createSSEStream } from "./sse.js";
//   // after resolving + authorising `address` exactly as /api/wait does:
//   if (path === "/api/stream" && request.method === "GET")
//     return createSSEStream(env, address, request);
// Suggested route name is /api/stream; it is not part of the v1/v2
// documented contract until the integrator wires and documents it.
// ---------------------------------------------------------------------------

// Tunables — kept deliberately conservative, see the comparison above.
export const SSE_POLL_MS = 2000;       // D1 re-check interval
export const SSE_PING_MS = 15000;      // `: ping` heartbeat interval
export const SSE_MAX_LIFETIME_MS = 55000; // hard cap, then `reconnect`
export const SSE_LIMIT = 20;           // max mails per D1 check

const encoder = new TextEncoder();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// First 4–8 digit sequence in text + subject — same convenience semantics
// as the `otp` field documented in docs/API.md. Duplicated (tiny) rather
// than imported so this module stays zero-dependency / standalone.
function extractOTP(text) {
  const m = (text || "").match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

function enrichRow(r) {
  return { ...r, otp: extractOTP((r.text_body || "") + " " + (r.subject || "")) };
}

// Initial cursor: `?since_id=` (or `?last_id=`) wins, then the standard
// SSE `Last-Event-ID` header (sent automatically by EventSource on
// reconnect), then 0 ("any mail already in the inbox counts").
function initialLastId(request) {
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("since_id") ?? url.searchParams.get("last_id");
    if (q !== null) {
      const n = parseInt(q, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch { /* non-URL request doubles in tests — fall through */ }
  const h = request.headers?.get?.("Last-Event-ID");
  if (h) {
    const n = parseInt(h, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * Create an SSE response streaming new mail for one inbox.
 *
 * @param {object} env      Worker env; must carry the D1 binding `DB`
 *                          (same binding as worker-v2.js).
 * @param {string} address  The authorised inbox address. The CALLER must
 *                          resolve and authorise it exactly as /api/wait
 *                          does (Bearer token, or address-as-capability)
 *                          before calling — this module trusts `address`
 *                          and performs no auth itself.
 * @param {Request} request The incoming request. Its URL supplies the
 *                          optional `since_id` cursor and its `signal`
 *                          (when present) closes the stream on abort.
 * @returns {Response} `text/event-stream` response. Emits:
 *   - `: connected …` comment on open
 *   - `event: mail` / `data: {…full mail incl. otp…}` per new mail,
 *     with an `id: <mail id>` line so EventSource tracks Last-Event-ID
 *   - `: ping` comment every 15 s (heartbeat; keeps proxies awake and
 *     proves liveness without creating a client-visible event)
 *   - `event: reconnect` once, after 55 s max lifetime, carrying the
 *     final `last_id` cursor — then the stream closes cleanly
 *   - `event: error` if a D1 read fails — then the stream closes
 */
export function createSSEStream(env, address, request) {
  const addr = String(address || "").toLowerCase();
  let lastId = initialLastId(request);
  const startedAt = Date.now();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (text) => {
        if (closed) return false;
        try { controller.enqueue(encoder.encode(text)); return true; }
        catch { closed = true; return false; }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      // Close promptly when the client goes away. `request.signal` is
      // not guaranteed on every runtime/test double, hence the guard.
      const signal = request?.signal;
      if (signal) {
        if (signal.aborted) { close(); return; }
        signal.addEventListener("abort", close, { once: true });
      }

      emit(`: connected address=${addr} since_id=${lastId}\n\n`);

      let nextPollAt = Date.now(); // first D1 check is immediate
      let nextPingAt = Date.now() + SSE_PING_MS;

      try {
        while (!closed && Date.now() - startedAt < SSE_MAX_LIFETIME_MS) {
          const now = Date.now();

          if (now >= nextPollAt) {
            nextPollAt = now + SSE_POLL_MS;
            const { results } = await env.DB.prepare(
              "SELECT id,address,sender,subject,text_body,html_body,created_at FROM mails WHERE address=? AND id>? ORDER BY id ASC LIMIT ?"
            ).bind(addr, lastId, SSE_LIMIT).all();
            // ASC order: events go out in arrival order, and lastId only
            // ever moves forward, so a reconnect can resume losslessly
            // with ?since_id=<lastId> (or the Last-Event-ID header).
            for (const row of results || []) {
              if (row.id > lastId) lastId = row.id;
              if (!emit(`id: ${row.id}\nevent: mail\ndata: ${JSON.stringify(enrichRow(row))}\n\n`)) break;
            }
            if (closed) break;
          }

          if (Date.now() >= nextPingAt) {
            nextPingAt = Date.now() + SSE_PING_MS;
            if (!emit(`: ping ${new Date().toISOString()}\n\n`)) break;
          }

          // Sleep until the next scheduled poll/ping, the lifetime cap,
          // or in small slices so an abort is honoured promptly.
          const wakeAt = Math.min(nextPollAt, nextPingAt, startedAt + SSE_MAX_LIFETIME_MS);
          const waitMs = Math.max(0, Math.min(wakeAt - Date.now(), 500));
          if (waitMs > 0) await sleep(waitMs);
        }
      } catch (e) {
        // D1 (or stream) failure: tell the client, then close — the
        // client's reconnect (with the last cursor) is the recovery path.
        emit(`event: error\ndata: ${JSON.stringify({ error: "Stream error", detail: String(e?.message || e) })}\n\n`);
        close();
        return;
      }

      // Max lifetime reached (not an abort): hand the client its resume
      // cursor explicitly before closing, per the module contract.
      if (!closed) {
        emit(`event: reconnect\ndata: ${JSON.stringify({
          reason: "max_lifetime",
          max_lifetime_ms: SSE_MAX_LIFETIME_MS,
          address: addr,
          last_id: lastId,
          retry_ms: 1000,
          hint: "Reconnect to the same URL with ?since_id=" + lastId + " (EventSource also sends Last-Event-ID automatically), or use GET /api/wait instead.",
        })}\n\n`);
      }
      close();
    },
    cancel() {
      // Client disconnected / stream cancelled by the runtime.
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream;charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      // Ask downstream proxies (e.g. nginx-style buffers) not to buffer.
      "X-Accel-Buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Client example — EventSource usage, as a string so the UI / docs / SDK
// agents can embed it verbatim. Note the honest constraint it documents:
// EventSource cannot set an Authorization header, so this example uses
// the address-as-capability URL form (same trust model as
// GET /api/inboxes/:address/messages in docs/API.md).
// ---------------------------------------------------------------------------
export const SSE_CLIENT_EXAMPLE = [
  "// Temp Mail SSE client (opt-in — prefer GET /api/wait by default,",
  "// see the comparison at the top of src/sse.js).",
  "// EventSource cannot set an Authorization header, so the address in",
  "// the URL is the capability — keep the URL as private as a token.",
  "",
  "const BASE = 'https://temp-mail.turjaun.workers.dev';",
  "const address = 'test123@turjaun.xyz'; // inbox you created",
  "let lastId = 0; // largest mail id already seen (0 = from scratch)",
  "",
  "function connect() {",
  "  const url = BASE + '/api/stream?address=' + encodeURIComponent(address)",
  "    + '&since_id=' + lastId;",
  "  const es = new EventSource(url);",
  "",
  "  es.addEventListener('mail', (e) => {",
  "    const mail = JSON.parse(e.data);",
  "    lastId = Math.max(lastId, mail.id); // e.lastEventId also carries it",
  "    console.log('New mail:', mail.subject, 'OTP:', mail.otp);",
  "    // ...show mail / use mail.otp / mail.text_body...",
  "  });",
  "",
  "  // Server closed the stream at its 55s max lifetime and told us the",
  "  // resume cursor. EventSource will NOT auto-reconnect after a clean",
  "  // server close in every browser, so reconnect manually with it.",
  "  es.addEventListener('reconnect', (e) => {",
  "    const info = JSON.parse(e.data);",
  "    lastId = info.last_id;",
  "    es.close();",
  "    setTimeout(connect, info.retry_ms || 1000);",
  "  });",
  "",
  "  es.onerror = () => {",
  "    // Transient failure: EventSource auto-reconnects and sends the",
  "    // Last-Event-ID header, so no mail is lost. If errors persist,",
  "    // fall back to GET /api/wait cycles instead of retrying tightly.",
  "  };",
  "",
  "  return es;",
  "}",
  "",
  "const stream = connect();",
  "// When the task / tab is done: stream.close(); — never leave it open.",
  "",
].join("\n");

export default createSSEStream;
