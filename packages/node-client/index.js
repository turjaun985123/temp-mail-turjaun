/**
 * @file index.js
 * @module @turjaun/temp-mail-client
 * @description Zero-dependency Node 18+ ESM client SDK for the Temp Mail API.
 *
 * API (base: https://temp-mail.turjaun.workers.dev):
 *   POST   /api/new_address                  { name?, domain? } -> { address, token, jwt?, expires_at? }
 *   GET    /api/mails                        Authorization: Bearer <token> -> { address, count, results }
 *   GET    /api/inboxes/:address/messages    -> { address, count, results[] (each may carry `otp`) }
 *   GET    /api/mail/:id                     -> mail object (has `otp`)
 *   DELETE /api/mail/:id                     Authorization: Bearer <token> -> { ok: true }
 *   GET    /api/wait                         (v2 long-poll) -> { results / mails, ... } or 204 / timeout
 *   GET    /api/health                       -> { ok: true, service, domain, time }
 *   GET    /api/config                       -> { domains, ttl_hours }
 *
 * No dependencies: uses the global `fetch`, `AbortController` and
 * `setTimeout` available in Node 18+.
 *
 * @example
 * import { TempMailClient } from '@turjaun/temp-mail-client';
 *
 * const client = new TempMailClient(); // defaults to the live base URL
 * const { address, token } = await client.createInbox();
 * console.log('Send mail to', address);
 * const otp = await client.waitForOTP(address, 60_000);
 * console.log('OTP:', otp);
 */

import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

/** Default live API base URL. */
export const DEFAULT_BASE_URL = 'https://temp-mail.turjaun.workers.dev';

/**
 * A single mail record as returned by the Temp Mail API.
 *
 * @typedef {object} Mail
 * @property {number} id            Mail id (monotonically increasing).
 * @property {string} [address]     Recipient address the mail belongs to.
 * @property {string} [sender]      Sender address.
 * @property {string} [subject]     Subject line.
 * @property {string} [preview]     Short text preview (list responses).
 * @property {string} [text_body]   Plain-text body (detail responses).
 * @property {string} [html_body]   HTML body (detail responses).
 * @property {string|null} [otp]    OTP extracted by the server, if any.
 * @property {number} [created_at]  Unix seconds when the mail was received.
 */

/**
 * An inbox created by {@link TempMailClient#createInbox}.
 *
 * @typedef {object} Inbox
 * @property {string} address       The temp-mail address, e.g. `abc@turjaun.xyz`.
 * @property {string} token         Bearer token for that inbox (also sent as `jwt` by the API).
 * @property {string} [jwt]         Alias of `token` as returned by the server.
 * @property {number} [expires_at]  Unix seconds when the inbox expires, if provided.
 * @property {boolean} [reused]     True when the address already existed.
 */

/**
 * Sleep helper (internal).
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>} Resolves after `ms`.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Heuristic: does a string look like an email address (vs. a bearer token)?
 * Tokens issued by the API are 64-char hex strings and never contain `@`.
 *
 * @param {unknown} value - Candidate token-or-address value.
 * @returns {boolean} True when `value` contains `@`.
 */
function isAddress(value) {
  return typeof value === 'string' && value.includes('@');
}

/**
 * Normalise the various list shapes the API returns into a plain mail array.
 * Accepts `{ results: [...] }`, `{ mails: [...] }`, or a bare array.
 *
 * @param {unknown} payload - Parsed JSON body from a list/wait endpoint.
 * @returns {Mail[]} The mail records (newest first, as the server returns them).
 */
function toMailArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.results)) return payload.results;
  if (payload && Array.isArray(payload.mails)) return payload.mails;
  if (payload && payload.mail && typeof payload.mail === 'object') return [payload.mail];
  if (payload && payload.result && typeof payload.result === 'object') return [payload.result];
  return [];
}

/**
 * Extract an OTP code from arbitrary text using the built-in JS extractor.
 * Prefers codes near keywords ("code", "otp", "verification", "pin") and
 * otherwise falls back to the first standalone 4–8 digit run — the same
 * rule the v1 Worker used server-side (`/\b(\d{4,8})\b/`).
 *
 * @param {unknown} text - Text (subject and/or body) to search.
 * @returns {string|null} The OTP, or `null` when none is found.
 */
export function extractOTPWithJS(text) {
  const s = String(text ?? '');
  if (!s) return null;
  const keyword =
    s.match(/(?:code|otp|verification|verify|pin|passcode)[^0-9]{0,24}(\d{4,8})\b/i) ||
    s.match(/\b(\d{4,8})[^0-9]{0,24}(?:code|otp|verification|pin)\b/i);
  if (keyword) return keyword[1];
  const plain = s.match(/\b(\d{4,8})\b/);
  return plain ? plain[1] : null;
}

/**
 * Get the OTP for a mail record, preferring the server-provided `otp`
 * field and falling back to local extraction from subject/body.
 *
 * @param {Mail|null|undefined} mail - Mail record to inspect.
 * @returns {string|null} The OTP, or `null`.
 */
function otpFromMail(mail) {
  if (!mail || typeof mail !== 'object') return null;
  if (mail.otp) return String(mail.otp);
  return extractOTPWithJS(`${mail.subject ?? ''}\n${mail.text_body ?? ''}\n${mail.preview ?? ''}`);
}

/**
 * Client for the Temp Mail API.
 */
export class TempMailClient {
  /**
   * Create a client.
   *
   * @param {string} [baseUrl] - API base URL. Trailing slashes are stripped.
   *   Defaults to {@link DEFAULT_BASE_URL} (`https://temp-mail.turjaun.workers.dev`).
   * @param {object} [options] - Extra client options.
   * @param {typeof fetch} [options.fetch] - Custom `fetch` implementation
   *   (defaults to the global Node 18+ `fetch`). Useful for tests/proxies.
   * @param {number} [options.requestTimeoutMs] - Per-request timeout in ms
   *   for ordinary (non-long-poll) requests. Default: `15000`.
   */
  constructor(baseUrl = DEFAULT_BASE_URL, options = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this._fetch = options.fetch ?? globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new Error('TempMailClient: no fetch available — Node 18+ is required, or pass options.fetch');
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  /**
   * Perform a JSON request against the API (internal).
   *
   * @param {string} path - Path starting with `/api/...` (query string allowed).
   * @param {object} [opts] - Request options.
   * @param {string} [opts.method] - HTTP method. Default: `'GET'`.
   * @param {string} [opts.token] - Bearer token to send, if any.
   * @param {unknown} [opts.body] - JSON body for POST requests.
   * @param {number} [opts.timeoutMs] - Abort the request after this many ms.
   * @param {AbortSignal} [opts.signal] - External abort signal.
   * @returns {Promise<any>} Parsed JSON body (`null` for empty/204 bodies).
   * @throws {Error} On non-2xx responses (message includes status and server error).
   */
  async _request(path, opts = {}) {
    const { method = 'GET', token, body, timeoutMs, signal } = opts;
    const controller = new AbortController();
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
    // Chain an external signal into our controller, if one was supplied.
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const res = await this._fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 204) return null;
      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!res.ok) {
        const detail = data && typeof data === 'object' && data.error ? data.error : text;
        const err = new Error(`TempMail API ${method} ${path} failed: ${res.status} ${detail ?? ''}`.trim());
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Check API liveness. `GET /api/health`.
   *
   * @returns {Promise<{ok: boolean, service?: string, domain?: string[], time?: string}>}
   *   The parsed health payload.
   */
  async health() {
    return this._request('/api/health');
  }

  /**
   * Read public API configuration. `GET /api/config`.
   *
   * @returns {Promise<{domains: string[], ttl_hours?: number}>} Config payload
   *   with the list of usable domains.
   */
  async config() {
    return this._request('/api/config');
  }

  /**
   * Create (or re-claim) a temp-mail inbox. `POST /api/new_address`.
   *
   * @param {string} [name] - Desired local part, e.g. `'test123'` for
   *   `test123@turjaun.xyz`. Omit / pass `undefined` for a random address.
   * @param {object} [opts] - Extra options.
   * @param {string} [opts.domain] - Domain to create the address on
   *   (must be one of the server's configured domains).
   * @returns {Promise<Inbox>} The created inbox: `{ address, token, ... }`.
   *   Keep the `token` — it authorises `listMails` / `deleteMail`.
   * @example
   * const { address, token } = await client.createInbox('test123');
   */
  async createInbox(name, opts = {}) {
    const payload = {};
    if (name !== undefined && name !== null && name !== '') payload.name = String(name);
    // Allow createInbox({ domain }) as a convenience overload.
    const domain = opts.domain ?? (name && typeof name === 'object' ? name.domain : undefined);
    if (domain) payload.domain = String(domain);
    const data = await this._request('/api/new_address', { method: 'POST', body: payload });
    if (!data || !data.address) throw new Error('TempMail API: createInbox returned no address');
    // Server returns `token` (and the same value as `jwt` in v1); normalise both.
    return { ...data, token: data.token ?? data.jwt ?? null, jwt: data.jwt ?? data.token ?? null };
  }

  /**
   * List mails for an inbox by bearer token. `GET /api/mails`.
   *
   * @param {string} token - Bearer token returned by {@link TempMailClient#createInbox}.
   * @param {object} [opts] - List options.
   * @param {number} [opts.limit] - Max mails to return (server caps at 50). Default: `20`.
   * @param {number} [opts.offset] - Pagination offset. Default: `0`.
   * @returns {Promise<Mail[]>} Mail records, newest first.
   */
  async listMails(token, opts = {}) {
    if (!token) throw new Error('TempMailClient.listMails: token is required');
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const data = await this._request(`/api/mails?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`, { token });
    return toMailArray(data);
  }

  /**
   * List mails for an address without a token.
   * `GET /api/inboxes/:address/messages` — the address itself is the secret.
   *
   * @param {string} address - Full address, e.g. `test123@turjaun.xyz`.
   * @param {object} [opts] - List options.
   * @param {number} [opts.limit] - Max mails to return (server caps at 50). Default: `20`.
   * @param {string} [opts.token] - Optional bearer token for that inbox.
   *   Per the project AGENTS.md, send the header on inbox/message calls
   *   anyway when you have it.
   * @returns {Promise<Mail[]>} Mail records, newest first (each may carry `otp`).
   */
  async listMailsByAddress(address, opts = {}) {
    if (!isAddress(address)) throw new Error('TempMailClient.listMailsByAddress: a full address is required');
    const limit = opts.limit ?? 20;
    const data = await this._request(
      `/api/inboxes/${encodeURIComponent(address)}/messages?limit=${encodeURIComponent(limit)}`,
      { token: opts.token },
    );
    return toMailArray(data);
  }

  /**
   * Fetch one mail in full (including its server-extracted `otp`).
   * `GET /api/mail/:id`.
   *
   * @param {number|string} id - Mail id from a list response.
   * @param {object} [opts] - Extra options.
   * @param {string} [opts.token] - Optional bearer token for the owning
   *   inbox (AGENTS.md: send the header on message calls when you have it).
   *   A bare string is also accepted here as the token for convenience.
   * @returns {Promise<Mail>} The full mail record, including `otp` when found.
   */
  async getMail(id, opts = {}) {
    if (id === undefined || id === null || id === '') throw new Error('TempMailClient.getMail: id is required');
    const token = typeof opts === 'string' ? opts : opts.token;
    return this._request(`/api/mail/${encodeURIComponent(String(id))}`, { token });
  }

  /**
   * Delete one mail from its inbox. `DELETE /api/mail/:id`.
   *
   * @param {string} token - Bearer token of the inbox that owns the mail.
   * @param {number|string} id - Mail id to delete.
   * @returns {Promise<{ok: boolean}>} Server acknowledgement, e.g. `{ ok: true }`.
   */
  async deleteMail(token, id) {
    if (!token) throw new Error('TempMailClient.deleteMail: token is required');
    if (id === undefined || id === null || id === '') throw new Error('TempMailClient.deleteMail: id is required');
    return this._request(`/api/mail/${encodeURIComponent(String(id))}`, { method: 'DELETE', token });
  }

  /**
   * One long-poll cycle against the v2 endpoint (internal).
   *
   * Per the project AGENTS.md (§2 Step 4, §4 #8) this is exactly
   * `GET /api/wait` with only the `Authorization: Bearer <token>` header —
   * no query parameters are documented for it, so none are invented or
   * sent. The server holds the request open until new mail arrives or its
   * own wait expires; one call is one wait cycle, and callers must never
   * run two of these for the same inbox in parallel. Filtering by
   * `sinceId` is done client-side by the caller.
   *
   * @param {object} args - Long-poll arguments.
   * @param {string} args.token - Bearer token for the inbox (header only).
   * @param {number} args.timeoutMs - Client-side abort budget for this
   *   cycle: the overall remaining deadline plus a grace margin, so a
   *   server-held request is not cut off prematurely.
   * @param {AbortSignal} [args.signal] - External abort signal.
   * @returns {Promise<Mail[]>} Mails reported by this wait cycle
   *   (possibly empty when the server-side wait timed out).
   * @throws {Error} Propagates HTTP errors so the caller can decide to fall back.
   */
  async _waitOnce({ token, timeoutMs, signal }) {
    if (!token) {
      // /api/wait requires the inbox token (AGENTS.md §3); without one
      // there is nothing to long-poll — signal the caller to fall back.
      const err = new Error('TempMailClient: /api/wait requires a bearer token');
      err.status = 401;
      throw err;
    }
    const data = await this._request('/api/wait', {
      token,
      signal,
      timeoutMs,
    });
    return toMailArray(data);
  }

  /**
   * Wait for the next new mail, using the v2 long-poll endpoint with an
   * automatic fallback to plain polling.
   *
   * Strategy (following the project AGENTS.md waiting rules — one
   * `/api/wait` request per cycle, never two waits in parallel):
   *  1. Token mode: call `GET /api/wait` once per cycle. The server holds
   *     the request open, so new mail returns almost instantly — this
   *     replaces the slow fixed-interval polling of v1. An empty cycle
   *     simply starts the next cycle, until the overall deadline.
   *  2. Fallback — only when `/api/wait` cannot be used (404 / 501 /
   *     network error, e.g. a v1 Worker is still deployed; or address
   *     mode, where no token exists to authorise `/api/wait`): poll
   *     `GET /api/inboxes/:address/messages` (address mode) or
   *     `GET /api/mails` (token mode) every `pollIntervalMs` for the rest
   *     of this call. This fallback exists for v1 compatibility; on a v2
   *     deployment with a token it should never be reached.
   *
   * @param {string} tokenOrAddress - Either an inbox bearer token (hex string)
   *   or a full address (`name@turjaun.xyz`). Addresses are detected by `@`.
   * @param {object} [opts] - Wait options.
   * @param {number} [opts.sinceId] - Only consider mails with `id > sinceId`
   *   (applied client-side). Default: `0` (any existing mail counts — pass
   *   the newest id you have already seen to wait strictly for the *next* mail).
   * @param {number} [opts.timeoutMs] - Overall deadline in ms. Default: `60000`.
   *   On expiry the promise resolves with `null` (it does not throw).
   * @param {number} [opts.pollIntervalMs] - Fallback polling interval. Default: `5000`.
   * @param {AbortSignal} [opts.signal] - Abort signal; aborting resolves `null`.
   * @returns {Promise<Mail|null>} The newest new mail, or `null` on timeout/abort.
   * @example
   * const mail = await client.waitForMail(token, { sinceId: lastSeenId, timeoutMs: 120_000 });
   */
  async waitForMail(tokenOrAddress, opts = {}) {
    if (!tokenOrAddress) throw new Error('TempMailClient.waitForMail: tokenOrAddress is required');
    const sinceId = opts.sinceId ?? 0;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;
    const byAddress = isAddress(tokenOrAddress);
    const token = byAddress ? undefined : String(tokenOrAddress);
    const address = byAddress ? String(tokenOrAddress) : undefined;
    // /api/wait requires a token (AGENTS.md §3): address-only callers
    // go straight to the /api/inboxes fallback below.
    let useLongPoll = !byAddress;

    const newestNew = (mails) => {
      const fresh = mails.filter((m) => typeof m?.id !== 'number' || m.id > sinceId);
      return fresh.length ? fresh[0] : null;
    };

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) return null;
      const remaining = deadline - Date.now();

      if (useLongPoll) {
        try {
          const mails = await this._waitOnce({
            token,
            // One cycle: let the server hold the request for the rest of
            // the overall deadline, plus a small grace margin. A return
            // (mail or server-side timeout) ends the cycle — never two
            // waits for the same inbox in parallel.
            timeoutMs: remaining + 5_000,
            signal: opts.signal,
          });
          const hit = newestNew(mails);
          if (hit) return hit;
          // Empty result = server-side hold timed out; loop and hold again.
          continue;
        } catch (err) {
          if (opts.signal?.aborted || err?.name === 'AbortError') {
            // An aborted long-poll may just be our per-round deadline; if the
            // overall deadline has passed, stop — otherwise fall back to polling.
            if (Date.now() >= deadline) return null;
          }
          // 404/501 (no /api/wait on this deployment) or any HTTP/network
          // failure: switch to polling for the remainder of this call.
          useLongPoll = false;
          if (Date.now() >= deadline) return null;
        }
      }

      // --- Fallback: plain polling of the v1 list endpoints ---
      try {
        const mails = byAddress
          ? await this.listMailsByAddress(address, { limit: 20 })
          : await this.listMails(token, { limit: 20 });
        const hit = newestNew(mails);
        if (hit) return hit;
      } catch {
        // Transient list error while waiting: ignore and retry until deadline.
        if (Date.now() >= deadline) return null;
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    return null;
  }

  /**
   * Wait until a mail carrying an OTP arrives for an address, and return
   * just the OTP code.
   *
   * Polls via {@link TempMailClient#waitForMail} (so it uses `/api/wait`
   * long-polling when available and falls back to `/api/inboxes` polling),
   * advancing `sinceId` past mails that contain no OTP so a code-less mail
   * (welcome message, receipt, …) does not end the wait early.
   *
   * @param {string} address - Full temp-mail address to watch,
   *   e.g. `test123@turjaun.xyz`. A bearer token is also accepted — it is
   *   simply forwarded to `waitForMail`.
   * @param {number} [timeout] - Overall deadline in ms. Default: `60000`.
   *   (An options object `{ timeoutMs, pollIntervalMs, sinceId, signal }`
   *   is also accepted in place of the number.)
   * @param {object} [opts] - Extra options when `timeout` is a number.
   * @param {number} [opts.sinceId] - Only consider mails with `id > sinceId`.
   * @param {number} [opts.pollIntervalMs] - Fallback polling interval. Default: `5000`.
   * @param {AbortSignal} [opts.signal] - Abort signal; aborting resolves `null`.
   * @returns {Promise<string|null>} The OTP from the newest mail that has
   *   one, or `null` on timeout/abort.
   * @example
   * const otp = await client.waitForOTP('test123@turjaun.xyz', 90_000);
   * if (!otp) throw new Error('No OTP arrived in time');
   */
  async waitForOTP(address, timeout = 60_000, opts = {}) {
    const options = typeof timeout === 'object' && timeout !== null ? timeout : opts;
    const timeoutMs = typeof timeout === 'number' ? timeout : (options.timeoutMs ?? options.timeout ?? 60_000);
    const deadline = Date.now() + timeoutMs;
    let sinceId = options.sinceId ?? 0;

    while (Date.now() < deadline) {
      const mail = await this.waitForMail(address, {
        sinceId,
        timeoutMs: deadline - Date.now(),
        pollIntervalMs: options.pollIntervalMs,
        signal: options.signal,
      });
      if (!mail) return null; // deadline reached inside waitForMail

      // The list payload may carry a truncated body; if it has no OTP yet,
      // fetch the full mail — the server extracts `otp` on the detail route.
      let otp = otpFromMail(mail);
      if (!otp && mail.id !== undefined) {
        try {
          const full = await this.getMail(mail.id);
          otp = otpFromMail(full);
        } catch {
          // Detail fetch is best-effort; keep waiting from this mail onwards.
        }
      }
      if (otp) return otp;

      // No code in this mail: move past it and keep waiting for the next one.
      if (typeof mail.id === 'number' && mail.id > sinceId) sinceId = mail.id;
      else await sleep(Math.min(options.pollIntervalMs ?? 5_000, Math.max(0, deadline - Date.now())));
    }
    return null;
  }
}

/**
 * Create a pre-configured client for the live turjaun.xyz service.
 *
 * @param {object} [options] - Options forwarded to {@link TempMailClient}.
 * @returns {TempMailClient} A client bound to {@link DEFAULT_BASE_URL}.
 */
export function createClient(options = {}) {
  return new TempMailClient(DEFAULT_BASE_URL, options);
}

export default TempMailClient;

// ---------------------------------------------------------------------------
// Rust parser integration point
// ---------------------------------------------------------------------------
//
// RUST BINARY / WASM INTEGRATION POINT
//
// The fast mail parser for Temp Mail v2 lives in Rust, in this workspace at:
//
//     packages/rust/mail-parser/          (cargo crate — see that package)
//       └─ built with `wasm-pack build --target web` (or `--target nodejs`)
//          into:  packages/rust/mail-parser/pkg/
//            ├─ mail_parser.js             (JS glue generated by wasm-pack)
//            └─ mail_parser_bg.wasm        (the compiled Rust binary as WASM)
//
// From this package that build output is reachable at:
//
//     ../rust/mail-parser/pkg/
//
// `loadRustParser()` below is the *only* place the Node client touches it:
//   1. It probes the candidate entry points inside `../rust/mail-parser/pkg/`
//      and dynamically `import()`s the first one that exists.
//   2. If the wasm-pack glue exposes an init function (`default` export or
//      `init` / `initSync`), it is awaited/called so the `.wasm` binary is
//      instantiated before any parsing happens.
//   3. The returned parser adapts whatever the Rust module exports —
//      `extract_otp` / `extractOtp`, `parse_mail` / `parseMail`, or
//      `parse` — to the small local interface `{ isRust, extractOTP, parse }`.
//   4. If the pkg directory does not exist (Rust toolchain not run yet,
//      plain JS checkout, CI without wasm-pack, …) or loading fails for
//      any reason, it silently falls back to the pure-JS extractor
//      ({@link extractOTPWithJS}). The client SDK works identically either
//      way — Rust is a speed optimisation for local parsing (large MIME
//      bodies, bulk OTP scans), never a hard dependency.
//
// To enable the Rust path: build the crate once
// (`cd ../rust/mail-parser && wasm-pack build --target web --out-dir pkg`)
// and this loader picks it up automatically on the next import — no code
// changes in the client are needed.
// ---------------------------------------------------------------------------

/**
 * Candidate entry points inside `../rust/mail-parser/pkg/`, in probe order.
 * `mail_parser.js` is wasm-pack's default file name for a crate named
 * `mail-parser` / `mail_parser`; the others cover renamed/custom builds.
 *
 * @type {string[]}
 */
const RUST_PARSER_CANDIDATES = [
  '../rust/mail-parser/pkg/mail_parser.js',
  '../rust/mail-parser/pkg/mail-parser.js',
  '../rust/mail-parser/pkg/index.js',
];

/**
 * Build the pure-JS fallback parser (same shape as the Rust parser).
 *
 * @returns {{isRust: false, extractOTP: (text: unknown) => string|null,
 *   parse: (raw: unknown) => {subject: string, text: string, otp: string|null}}}
 *   A parser object backed only by JavaScript.
 */
function jsFallbackParser() {
  return {
    isRust: false,
    /**
     * Extract an OTP from text with the JS extractor.
     *
     * @param {unknown} text - Text to search.
     * @returns {string|null} The OTP, or `null`.
     */
    extractOTP: (text) => extractOTPWithJS(text),
    /**
     * Minimal JS "parse": there is no full MIME parser in the fallback, so
     * it returns the raw text as the body and extracts the OTP from it.
     * (Server-side mails already arrive parsed via the API; this is only
     * for locally supplied raw messages.)
     *
     * @param {unknown} raw - Raw message text.
     * @returns {{subject: string, text: string, otp: string|null}} Parsed shape.
     */
    parse: (raw) => {
      const text = String(raw ?? '');
      return { subject: '', text, otp: extractOTPWithJS(text) };
    },
  };
}

/**
 * Adapt a loaded Rust/WASM module to the local parser interface.
 *
 * @param {Record<string, any>} mod - The dynamically imported wasm-pack module.
 * @returns {{isRust: true, extractOTP: (text: unknown) => string|null,
 *   parse: (raw: unknown) => any}} A parser object backed by Rust/WASM.
 */
function adaptRustParser(mod) {
  const rustExtract = mod.extract_otp ?? mod.extractOtp ?? mod.extractOTP ?? null;
  const rustParse = mod.parse_mail ?? mod.parseMail ?? mod.parse ?? null;
  return {
    isRust: true,
    /**
     * Extract an OTP using the Rust implementation, falling back to JS
     * when the Rust export is missing or returns nothing.
     *
     * @param {unknown} text - Text to search.
     * @returns {string|null} The OTP, or `null`.
     */
    extractOTP: (text) => {
      const s = String(text ?? '');
      if (typeof rustExtract === 'function') {
        try {
          const out = rustExtract(s);
          if (out) return String(out);
        } catch { /* fall through to JS */ }
      }
      return extractOTPWithJS(s);
    },
    /**
     * Parse a raw message using the Rust implementation.
     *
     * @param {unknown} raw - Raw RFC 822 message text.
     * @returns {any} Whatever the Rust parser returns (normally
     *   `{ subject, from, text, html, otp }`), or the JS fallback shape.
     */
    parse: (raw) => {
      const s = String(raw ?? '');
      if (typeof rustParse === 'function') {
        try { return rustParse(s); } catch { /* fall through to JS */ }
      }
      return { subject: '', text: s, otp: extractOTPWithJS(s) };
    },
  };
}

/**
 * Load the Rust mail parser (compiled to WebAssembly) if it has been built,
 * otherwise return the pure-JS fallback parser.
 *
 * This is a stub/integration point — see the "RUST BINARY / WASM
 * INTEGRATION POINT" comment above for the full explanation. It never
 * throws: any failure to find, load or initialise the WASM module results
 * in the JS fallback.
 *
 * @returns {Promise<{isRust: boolean,
 *   extractOTP: (text: unknown) => string|null,
 *   parse: (raw: unknown) => any}>} A parser object; check `.isRust` to
 *   know which implementation you got.
 * @example
 * const parser = await loadRustParser();
 * console.log(parser.isRust ? 'Rust/WASM parser' : 'JS fallback parser');
 * const otp = parser.extractOTP('Your verification code is 123456');
 */
export async function loadRustParser() {
  for (const rel of RUST_PARSER_CANDIDATES) {
    const url = new URL(rel, import.meta.url);
    try {
      // Probe first: dynamic import of a missing file throws, but an
      // explicit existence check keeps the intent clear and avoids
      // noisy module-resolution errors on plain JS checkouts.
      await access(url, fsConstants.F_OK);
    } catch {
      continue; // Not built (yet) at this candidate path — try the next.
    }
    try {
      const mod = await import(url.href);
      // wasm-pack `--target web` glue needs an explicit init() with the
      // sibling .wasm file; `--target nodejs` / bundler builds do not.
      const init = typeof mod.default === 'function' ? mod.default : (mod.init ?? mod.initSync ?? null);
      if (init) {
        try { await init(); } catch { /* init may already have run / be sync-only */ }
      }
      return adaptRustParser(mod);
    } catch {
      // Corrupt or incompatible build at this path — try the next
      // candidate, and ultimately the JS fallback below.
      continue;
    }
  }
  return jsFallbackParser();
}
