// Temp Mail API — integration tests (zero-dependency)
//
// Runnable via:
//   node --test tests/api.test.mjs
//
// Base URL:
//   TEMP_MAIL_BASE=https://temp-mail.turjaun.workers.dev node --test tests/api.test.mjs
//   (defaults to https://temp-mail.turjaun.workers.dev)
//
// Notes:
// - Uses only Node built-ins: node:test, node:assert/strict and global fetch.
// - Every test that needs an inbox creates its OWN random inbox name, so
//   tests never collide with each other or with real user inboxes, and the
//   suite is safe to run repeatedly / in parallel.
// - The /api/wait test is v2-only: on v1 it receives 404 and marks itself
//   skipped instead of failing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.TEMP_MAIL_BASE || 'https://temp-mail.turjaun.workers.dev').replace(/\/+$/, '');
const DOMAIN = 'turjaun.xyz';

/** Unique, API-valid inbox local-part for a single test. */
function randomName(label = 't') {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  // Keep it lowercase alphanumeric (worker strips anything else) and short.
  return `${label}${Date.now().toString(36)}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
}

/** fetch + JSON parse (tolerating empty / non-JSON bodies). Returns { res, body, text }. */
async function fetchJson(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { res, body, text };
}

/** Create an inbox; by default with a fresh random name for this caller. */
async function createInbox(name = randomName()) {
  const { res, body } = await fetchJson('/api/new_address', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, domain: DOMAIN }),
  });
  assert.equal(res.status, 200, `create inbox "${name}" should return 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body && typeof body === 'object', 'create inbox should return a JSON object');
  return body;
}

test('health returns ok:true', { timeout: 15_000 }, async () => {
  const { res, body } = await fetchJson('/api/health');
  assert.equal(res.status, 200);
  assert.ok(body, 'health should return JSON');
  assert.equal(body.ok, true);
});

test('config lists turjaun.xyz', { timeout: 15_000 }, async () => {
  const { res, body } = await fetchJson('/api/config');
  assert.equal(res.status, 200);
  assert.ok(body, 'config should return JSON');
  const domains = body.domains ?? body.domain ?? [];
  const list = Array.isArray(domains) ? domains : [domains];
  assert.ok(
    list.includes(DOMAIN),
    `config domains should include ${DOMAIN}, got ${JSON.stringify(body)}`,
  );
});

test('create inbox returns address ending @turjaun.xyz + token', { timeout: 15_000 }, async () => {
  const name = randomName('create');
  const body = await createInbox(name);
  assert.equal(typeof body.address, 'string');
  assert.ok(body.address.endsWith(`@${DOMAIN}`), `address should end with @${DOMAIN}, got ${body.address}`);
  assert.equal(body.address, `${name}@${DOMAIN}`);
  assert.equal(typeof body.token, 'string');
  assert.ok(body.token.length > 0, 'token should be non-empty');
});

test('create with custom name reuses / returns same address', { timeout: 15_000 }, async () => {
  const name = randomName('reuse');
  const first = await createInbox(name);
  const second = await createInbox(name);
  assert.equal(first.address, `${name}@${DOMAIN}`);
  assert.equal(second.address, first.address, 're-creating the same name should return the same address');
  assert.equal(typeof second.token, 'string');
  assert.ok(second.token.length > 0, 'reused inbox should still return a token');
});

test('list mails with token returns array (empty ok)', { timeout: 15_000 }, async () => {
  const inbox = await createInbox(randomName('list'));
  const { res, body } = await fetchJson('/api/mails?limit=20&offset=0', {
    headers: { Authorization: `Bearer ${inbox.token}` },
  });
  assert.equal(res.status, 200);
  assert.ok(body, 'list mails should return JSON');
  const results = body.results ?? body.mails ?? body.messages;
  assert.ok(Array.isArray(results), `list mails should return an array of results, got ${JSON.stringify(body)}`);
  // A brand-new inbox is normally empty — empty is fine, shape is what matters.
  if (typeof body.count === 'number') {
    assert.equal(body.count, results.length, 'count should match results length when present');
  }
});

test('list mails without token returns 401', { timeout: 15_000 }, async () => {
  // Still create this test's own inbox first (isolation), then deliberately
  // call the authenticated endpoint WITHOUT its token.
  await createInbox(randomName('noauth'));
  const { res } = await fetchJson('/api/mails?limit=20');
  assert.equal(res.status, 401, `list mails without token should return 401, got ${res.status}`);
});

test('get mail 999999999 returns 404', { timeout: 15_000 }, async () => {
  // Create this test's own inbox so the 404 is checked in a realistic flow.
  await createInbox(randomName('missing'));
  const { res } = await fetchJson('/api/mail/999999999');
  assert.equal(res.status, 404, `unknown mail id should return 404, got ${res.status}`);
});

test('inboxes/:address/messages returns structure with count', { timeout: 15_000 }, async () => {
  const inbox = await createInbox(randomName('inbox'));
  const { res, body } = await fetchJson(
    `/api/inboxes/${encodeURIComponent(inbox.address)}/messages`,
  );
  assert.equal(res.status, 200);
  assert.ok(body, 'inbox messages should return JSON');
  assert.equal(typeof body.count, 'number', `response should carry a numeric count, got ${JSON.stringify(body)}`);
  const results = body.results ?? body.messages ?? body.mails;
  assert.ok(Array.isArray(results), 'inbox messages should carry an array of results');
  assert.equal(body.count, results.length, 'count should match the number of returned messages');
  if (typeof body.address === 'string') {
    assert.equal(body.address, inbox.address);
  }
});

test(
  'wait endpoint returns within 30s with timeout:true or results (skipped on v1 / 404)',
  { timeout: 35_000 },
  async (t) => {
    const inbox = await createInbox(randomName('wait'));
    // Long-poll for new mail on an (empty) inbox with a short server-side
    // wait, so a v2 server answers timeout:true quickly instead of the
    // test hanging for the full server default.
    const query = new URLSearchParams({
      address: inbox.address,
      timeout: '3',
      timeout_seconds: '3',
    });
    const started = Date.now();
    const { res, body } = await fetchJson(`/api/wait?${query.toString()}`, {
      headers: { Authorization: `Bearer ${inbox.token}` },
    });
    const elapsedMs = Date.now() - started;

    if (res.status === 404) {
      // v1 has no /api/wait — that is expected, not a failure.
      t.skip('/api/wait not available on this server (404 — v1)');
      return;
    }

    assert.equal(res.status, 200, `wait should return 200 when available, got ${res.status}: ${JSON.stringify(body)}`);
    assert.ok(elapsedMs < 30_000, `wait should return within 30s, took ${elapsedMs}ms`);
    assert.ok(body && typeof body === 'object', 'wait should return a JSON object');

    const results = body.results ?? body.messages ?? body.mails;
    const timedOut = body.timeout === true || body.timed_out === true;
    assert.ok(
      timedOut || Array.isArray(results),
      `wait should return timeout:true or a results array, got ${JSON.stringify(body)}`,
    );
    if (Array.isArray(results) && typeof body.count === 'number') {
      assert.equal(body.count, results.length, 'count should match results length when present');
    }
  },
);
