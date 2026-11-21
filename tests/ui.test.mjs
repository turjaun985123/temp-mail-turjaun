// tests/ui.test.mjs — Temp Mail v2 UI static QA suite
// Zero-dependency: only node:test, node:assert, node:fs, node:path, node:url.
// Run from repo root:  node --test tests/ui.test.mjs
// Static checks only: reads ui/index.html, ui/app.js, ui/styles.css as text
// and asserts the contracts the UI depends on. No DOM, no network, no deps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = join(repoRoot, 'ui');

function readUi(name) {
  const path = join(uiDir, name);
  assert.ok(existsSync(path), `ui/${name} should exist`);
  return readFileSync(path, 'utf8');
}

const html = readUi('index.html');
const appJs = readUi('app.js');
const css = readUi('styles.css');

// ---------------------------------------------------------------------------
// index.html — required element IDs
// ---------------------------------------------------------------------------

const REQUIRED_IDS = [
  'name',
  'domain',
  'createBtn',
  'randomBtn',
  'addr',
  'token',
  'copyAddr',
  'inbox',
  'view',
  'search',
  'refreshBtn',
  'status',
];

test('index.html contains all required element IDs', () => {
  for (const id of REQUIRED_IDS) {
    // Match id="..." or id='...' exactly, not a prefix of a longer id.
    const re = new RegExp(`\\bid\\s*=\\s*["']${id}["']`);
    assert.match(html, re, `index.html should contain id="${id}"`);
  }
});

test('index.html has exactly one occurrence of each required ID', () => {
  for ( const id of REQUIRED_IDS) {
    const re = new RegExp(`\\bid\\s*=\\s*["']${id}["']`, 'g');
    const count = (html.match(re) || []).length;
    assert.equal(count, 1, `id="${id}" should appear exactly once, found ${count}`);
  }
});

// ---------------------------------------------------------------------------
// index.html — no external resources (no CDN)
// ---------------------------------------------------------------------------

test('index.html loads no external http/https resources (no CDN)', () => {
  // Any src= / href= / action= / poster= pointing at http://, https://, or
  // a protocol-relative //host URL is an external resource.
  const externalAttr =
    /\b(?:src|href|action|poster)\s*=\s*["']\s*(?:https?:)?\/\/[^"']+["']/gi;
  const found = html.match(externalAttr) || [];
  assert.deepEqual(found, [], `external resources found: ${found.join(', ')}`);

  // Belt-and-braces: no well-known CDN / external-asset hosts anywhere.
  assert.doesNotMatch(
    html,
    /(?:cdn\.|googleapis\.com|unpkg\.com|jsdelivr\.net|cloudflare\.com\/ajax|cdnjs\.com)/i,
    'index.html should not reference a CDN host',
  );

  // Stylesheet and script must be the local, relative files.
  assert.match(html, /\bhref\s*=\s*["']styles\.css["']/, 'should link local styles.css');
  assert.match(html, /\bsrc\s*=\s*["']app\.js["']/, 'should load local app.js');
});

// ---------------------------------------------------------------------------
// app.js — live updates via /api/wait, not legacy polling
// ---------------------------------------------------------------------------

test('app.js uses the /api/wait long-poll endpoint', () => {
  assert.match(appJs, /\/api\/wait\b/, 'app.js should call /api/wait');
  assert.match(
    appJs,
    /fetch\(\s*['"`]\/api\/wait/,
    'app.js should fetch() /api/wait',
  );
});

test('app.js uses AbortController to cancel in-flight waits', () => {
  assert.match(appJs, /\bAbortController\b/, 'app.js should reference AbortController');
  assert.match(appJs, /new\s+AbortController\s*\(/, 'app.js should construct an AbortController');
  assert.match(appJs, /\.abort\s*\(/, 'app.js should call .abort()');
  assert.match(appJs, /AbortError/, 'app.js should handle AbortError');
});

test('app.js handles visibilitychange (pause when tab hidden)', () => {
  assert.match(appJs, /visibilitychange/, 'app.js should listen for visibilitychange');
  assert.match(
    appJs,
    /addEventListener\(\s*['"]visibilitychange['"]/,
    'app.js should addEventListener("visibilitychange", ...)',
  );
  assert.match(appJs, /document\.hidden/, 'app.js should check document.hidden');
});

test('app.js does NOT contain the legacy 10000ms setInterval polling pattern', () => {
  assert.doesNotMatch(
    appJs,
    /setInterval\s*\([^)]*,\s*10000\s*\)/,
    'app.js should not poll with setInterval(..., 10000)',
  );
  assert.doesNotMatch(
    appJs,
    /setInterval\s*\([^)]*,\s*10\s*\*\s*1000\s*\)/,
    'app.js should not poll with setInterval(..., 10 * 1000)',
  );
  // The literal legacy interval value must not appear as a timer delay at all.
  assert.doesNotMatch(appJs, /, {0,4}10000\)/, 'app.js should not use a 10000ms timer delay');
});

// ---------------------------------------------------------------------------
// app.js — output escaping
// ---------------------------------------------------------------------------

test('app.js escapes untrusted content (esc helper and/or textContent)', () => {
  const hasEscHelper = /\besc\s*\(/.test(appJs) || /function\s+esc\b/.test(appJs) ||
    /escapeHtml/.test(appJs) || /&(?:amp|lt|gt|quot);/.test(appJs);
  const usesTextContent = /\.textContent\s*=/.test(appJs);
  assert.ok(
    hasEscHelper || usesTextContent,
    'app.js should escape content via an esc/escape helper or textContent assignment',
  );
  // Stronger, specific expectations for this codebase:
  assert.match(appJs, /\.textContent\s*=/, 'app.js should assign via textContent (not raw HTML)');
  assert.ok(
    /\besc\s*\(/.test(appJs) || /escape/.test(appJs),
    'app.js should define/use an escape helper (esc)',
  );
  // Escaping must actually encode the HTML-significant characters.
  assert.match(appJs, /&lt;/, 'escape helper should encode < as &lt;');
  assert.match(appJs, /&gt;/, 'escape helper should encode > as &gt;');
  assert.match(appJs, /&amp;/, 'escape helper should encode & as &amp;');
});

// ---------------------------------------------------------------------------
// styles.css — responsive breakpoint, reduced motion, focus visibility
// ---------------------------------------------------------------------------

test('styles.css contains the 720px responsive breakpoint', () => {
  assert.match(
    css,
    /@media[^{]*\(\s*max-width\s*:\s*720px\s*\)/,
    'styles.css should have an @media (max-width: 720px) breakpoint',
  );
});

test('styles.css respects prefers-reduced-motion', () => {
  assert.match(
    css,
    /@media[^{]*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
    'styles.css should have an @media (prefers-reduced-motion: reduce) block',
  );
});

test('styles.css contains :focus-visible styling', () => {
  assert.match(css, /:focus-visible\b/, 'styles.css should style :focus-visible');
  assert.match(
    css,
    /[^{}]*:focus-visible[^{}]*\{[^}]*outline\s*:/,
    ':focus-visible rules should set a visible outline',
  );
});
