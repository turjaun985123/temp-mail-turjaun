#!/usr/bin/env node
/**
 * node-signup-otp.mjs — complete, runnable signup-OTP example.
 *
 * Uses the `@turjaun/temp-mail-client` SDK. In a published install you would
 * write:
 *
 *     import { TempMailClient } from '@turjaun/temp-mail-client';
 *
 * Inside this repo the same package is imported by relative path, so the
 * example runs with no install step and no dependencies (Node 18+):
 *
 *     import { TempMailClient } from '../packages/node-client/index.js';
 *
 * What it does (the AGENTS.md workflow, end to end):
 *   1. Health-checks the Temp Mail API.
 *   2. Creates a disposable inbox on turjaun.xyz and prints the address.
 *      -> You use that address in the signup form of the service you are
 *         testing, so the service sends its verification mail there.
 *   3. Waits for an OTP with `waitForOTP` and a 120-second timeout.
 *      Passing the inbox *token* (not the address) is what enables the
 *      v2 long-poll: `waitForOTP` forwards it to `waitForMail`, which
 *      holds one `GET /api/wait` request open per cycle instead of
 *      polling `GET /api/mails` on a timer. Never poll in a loop yourself.
 *   4. Prints the OTP and exits.
 *
 * Usage:
 *   node examples/node-signup-otp.mjs [inbox-name]
 *
 *   [inbox-name]  Optional local part, e.g. `signup-test-01` creates
 *                 `signup-test-01@turjaun.xyz`. Omit it for a random
 *                 address. Reusing a name re-claims the same inbox.
 *
 * Environment:
 *   TEMP_MAIL_BASE_URL  Override the API base URL
 *                       (default: https://temp-mail.turjaun.workers.dev).
 *
 * Exit codes:
 *   0  An OTP arrived and was printed.
 *   1  No OTP arrived within 120 seconds (timeout — not a crash).
 *   2  The API could not be used (health check failed, inbox creation
 *      failed, or another request error). Details go to stderr.
 *
 * Secrets: the inbox token is never printed, in full or in part. The OTP
 * is printed because that is the entire point of this example — treat the
 * output as a secret and do not log it anywhere durable.
 */

import { TempMailClient, DEFAULT_BASE_URL } from '../packages/node-client/index.js';

const TIMEOUT_MS = 120_000; // 120s overall deadline for the OTP to arrive.
const EXIT_OK = 0;
const EXIT_NO_OTP = 1;
const EXIT_API_ERROR = 2;

async function main() {
  const baseUrl = process.env.TEMP_MAIL_BASE_URL || DEFAULT_BASE_URL;
  const client = new TempMailClient(baseUrl);
  const requestedName = process.argv[2] || undefined;

  // --- 1. Health check (once — never in a loop) ---------------------------
  const health = await client.health();
  if (!health || health.ok !== true) {
    console.error('Temp Mail service is not up — stopping.');
    process.exit(EXIT_API_ERROR);
  }

  // --- 2. Create the inbox --------------------------------------------------
  // Keep `token` in memory only. It authorises this one inbox and nothing
  // else; losing it loses authenticated access to the inbox.
  const { address, token } = await client.createInbox(requestedName);
  if (!token) {
    console.error(`Inbox ${address} was created without a token — cannot wait for mail.`);
    process.exit(EXIT_API_ERROR);
  }

  console.log(`Inbox created: ${address}`);
  console.log('');
  console.log('Next step: use this address in the signup form you are testing,');
  console.log('then submit the form so the service sends its verification mail.');
  console.log(`Waiting up to ${TIMEOUT_MS / 1000}s for an OTP (long-poll, do not interrupt)...`);

  // --- 3. Wait for the OTP ----------------------------------------------------
  // Token mode => GET /api/wait long-poll, one request per wait cycle,
  // handled entirely inside the client. This call resolves with the OTP
  // string, or with null when the 120s deadline passes.
  const otp = await client.waitForOTP(token, TIMEOUT_MS);

  if (!otp) {
    console.error(`No OTP arrived for ${address} within ${TIMEOUT_MS / 1000}s.`);
    console.error('Check that the signup form was submitted to the address above, then re-run.');
    process.exit(EXIT_NO_OTP);
  }

  // --- 4. Print the OTP -------------------------------------------------------
  console.log(`OTP for ${address}: ${otp}`);
  process.exit(EXIT_OK);
}

main().catch((err) => {
  // Any thrown error here is an API/transport failure (non-2xx response,
  // network error, malformed reply) — report it without leaking internals.
  const status = err && typeof err === 'object' && 'status' in err ? ` (HTTP ${err.status})` : '';
  console.error(`Temp Mail API error${status}: ${err?.message ?? err}`);
  process.exit(EXIT_API_ERROR);
});
