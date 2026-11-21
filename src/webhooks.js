// webhooks.js — outbound webhook delivery for Temp Mail v2 (turjaun.xyz)
// Zero-dependency ESM module (WebCrypto + fetch only). Import from the Worker:
//
//   import { deliverWebhook } from "./webhooks.js";
//
// How the Worker's email() handler calls it (via ctx.waitUntil):
//
//   async email(message, env, ctx) {
//     // ... parse with parseRaw(), ensure the address row exists, then:
//     const res = await env.DB.prepare(
//       "INSERT INTO mails (address,sender,subject,text_body,html_body,raw_size) VALUES (?,?,?,?,?,?)"
//     ).bind(to, message.from, parsed.subject, parsed.text, parsed.html, rawText.length).run();
//     const mail = {
//       id: res.meta?.last_row_id ?? null,
//       address: to,
//       sender: message.from || parsed.from,
//       subject: parsed.subject,
//       otp: extractOTP(parsed.text + " " + parsed.subject),
//       created_at: Math.floor(Date.now() / 1000),
//     };
//     // Fire-and-forget: waitUntil() keeps the Worker alive until delivery
//     // settles WITHOUT delaying the email handler's return, and
//     // deliverWebhook() never throws, so this cannot produce an unhandled
//     // rejection or fail the mail insert that already happened.
//     ctx.waitUntil(deliverWebhook(env, "mail.received", mail));
//   }
//
// Required vars (Worker environment / wrangler vars — never hard-code them):
//   WEBHOOK_URL     Destination endpoint, e.g. "https://example.com/hooks/mail".
//                   If unset/empty, delivery is a no-op: { delivered: false }.
//   WEBHOOK_SECRET  Shared HMAC secret. If set, every delivery carries an
//                   X-TempMail-Signature header (hex HMAC-SHA256 of the exact
//                   raw request body — see signPayload). If unset, the request
//                   is sent unsigned; set it in production.
//
// Security notes:
//   - https only: validateWebhookUrl() rejects http:// and every other
//     scheme, so mail (including OTPs) is never sent in plaintext and a
//     downgraded/misconfigured URL fails closed instead of delivering.
//   - The URL comes ONLY from the server-side WEBHOOK_URL var — never from
//     mail content, headers, or API/user input (SSRF: an attacker who can
//     send mail must not be able to choose where webhooks are POSTed).
//   - The secret itself is never sent, logged, or put in the body; only its
//     HMAC of the body is. Receivers must recompute the HMAC over the RAW
//     body they received and compare in constant time, and should reject
//     stale payloads (compare mail.created_at against their clock) to limit
//     replay. Rotate WEBHOOK_SECRET if it may have leaked; old signatures
//     then stop verifying.
//   - The payload intentionally contains the extracted OTP (that is the
//     point of the hook) — treat the destination as trusted, and do not log
//     the request body here or at the receiver beyond what you must.
//   - Single attempt, 5s timeout, no retry queue: delivery is at-most-once.
//     A slow/down receiver can never hang the email handler or pile up
//     retries; failures are only logged (address + status/error name, never
//     the body, secret, or signature).

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

export default deliverWebhook;
