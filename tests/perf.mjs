// Temp Mail — performance measurement script (zero-dependency)
//
// Runnable via:
//   node tests/perf.mjs
//   TEMP_MAIL_BASE=https://temp-mail.turjaun.workers.dev node tests/perf.mjs
//   (base defaults to https://temp-mail.turjaun.workers.dev)
//
// What it does:
// - Takes N = 5 samples per endpoint, sequentially (never in parallel, so
//   the script does not create the load it is trying to measure):
//     GET  /api/health
//     GET  /api/config
//     POST /api/new_address              (a unique random name per sample)
//     GET  /api/inboxes/:addr/messages   (for the last inbox created above)
//     GET  /api/wait?since_id=<latest>   (v2 only, see below)
// - Reports min / median / p95 / max per endpoint in a table.
// - Prints a VERDICT section comparing medians against the measured v1
//   baselines and flagging regressions.
//
// /api/wait handling:
// - since_id is set to the latest mail id already seen for the inbox, so
//   no mail counts as "new" and the call is expected to take the timeout
//   path. The server wait is kept short (timeout=3s) so this script stays
//   quick; the measured duration is reported, not hidden.
// - On v1 the endpoint does not exist and returns 404. That is NOT a
//   failure: the endpoint is reported as "v1 mode" and skipped, and the
//   verdict records that mail-visible latency is still polling-bound.
//
// Notes:
// - Uses only Node built-ins and globals (fetch, performance, crypto).
//   No imports at all, no test framework — this is a measurement tool,
//   not a test suite (see tests/api.test.mjs for correctness tests).
// - Samples that error (network failure, non-2xx where 2xx is expected)
//   are counted and reported, never silently dropped from the count.
// - Exit code is 0 even when regressions are flagged: the verdict is a
//   report for a human / parent run to act on, not a pass/fail gate.

const BASE = (process.env.TEMP_MAIL_BASE || 'https://temp-mail.turjaun.workers.dev').replace(/\/+$/, '');
const DOMAIN = 'turjaun.xyz';
const N = 5;

// Server-side wait requested for /api/wait samples, in seconds. Short on
// purpose: we are timing the timeout path, not waiting for real mail.
const WAIT_TIMEOUT_S = 3;
// Client-side abort for /api/wait samples: server timeout + generous slack.
const WAIT_CLIENT_TIMEOUT_MS = (WAIT_TIMEOUT_S + 12) * 1000;
// Client-side abort for every other (non-long-poll) sample.
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// v1 baselines (measured against the live v1 service, 2026-11-21)
// ---------------------------------------------------------------------------
const BASELINES = {
  healthMedianS: 0.33, // GET /api/health — median
  messagesMedianS: 0.59, // GET /api/inboxes/:addr/messages — median
  mailVisibleWorstS: 10.6, // v1 web-UI polling (10s interval): worst-case
  // delay between a mail landing and a polling client seeing it.
};

// A median counts as a regression only if it is both above the baseline
// and above it by more than this relative tolerance — avoids flagging
// ordinary network jitter as a regression on a 5-sample run.
const REGRESSION_TOLERANCE = 0.2; // 20%

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique, API-valid inbox local-part. */
function randomName(label = 'perf') {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${label}${Date.now().toString(36)}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
}

/**
 * Run one timed request. Returns { ms, status, body, text, error }.
 * Never throws: a failed sample is data, not a crashed run.
 */
async function timed(fn) {
  const started = performance.now();
  try {
    const { res, body, text } = await fn();
    return { ms: performance.now() - started, status: res.status, body, text, error: null };
  } catch (err) {
    return {
      ms: performance.now() - started,
      status: null,
      body: null,
      text: '',
      error: err && err.name === 'TimeoutError' ? 'client timeout' : String(err?.message || err),
    };
  }
}

/** fetch + JSON parse (tolerating empty / non-JSON bodies). */
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

/** Statistics over successful sample durations (seconds). */
function stats(samplesS) {
  if (samplesS.length === 0) return null;
  const sorted = [...samplesS].sort((a, b) => a - b);
  const at = (idx) => sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  // Nearest-rank p95.
  const p95 = at(Math.ceil(0.95 * sorted.length) - 1);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { count: sorted.length, min: sorted[0], median, p95, max: sorted[sorted.length - 1], mean };
}

function fmtS(v) {
  return v === null || v === undefined ? '   -  ' : `${v.toFixed(3)}s`;
}

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Measure one endpoint: run `makeSample` N times sequentially and collect
 * durations of samples accepted by `isOk`. Returns a result row object.
 */
async function measure(label, makeSample, isOk) {
  const durationsS = [];
  const statuses = [];
  let errors = 0;
  let lastSample = null;

  for (let i = 0; i < N; i += 1) {
    const sample = await timed(makeSample);
    lastSample = sample;
    statuses.push(sample.status === null ? 'ERR' : sample.status);
    if (!sample.error && isOk(sample)) {
      durationsS.push(sample.ms / 1000);
    } else {
      errors += 1;
    }
  }

  return { label, stats: stats(durationsS), attempted: N, errors, statuses, lastSample };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('Temp Mail — perf measurement');
console.log(`Base:    ${BASE}`);
console.log(`Samples: ${N} per endpoint (sequential)`);
console.log('');

const rows = [];

// 1 — Health -----------------------------------------------------------------
rows.push(
  await measure('GET /api/health', () => fetchJson('/api/health', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }), (s) => s.status === 200),
);

// 2 — Config -----------------------------------------------------------------
rows.push(
  await measure('GET /api/config', () => fetchJson('/api/config', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }), (s) => s.status === 200),
);

// 3 — Create inbox (unique random name per sample) ---------------------------
// Keep every created inbox; the last one is reused for the messages and
// wait measurements below so those measure a real, existing inbox.
const createdInboxes = [];
rows.push(
  await measure(
    'POST /api/new_address',
    async () => {
      const result = await fetchJson('/api/new_address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: randomName(), domain: DOMAIN }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (result.res.status === 200 && result.body && typeof result.body.address === 'string') {
        createdInboxes.push(result.body);
      }
      return result;
    },
    (s) => s.status === 200 && s.body && typeof s.body.address === 'string',
  ),
);

const inbox = createdInboxes[createdInboxes.length - 1] || null;

// 4 — Inbox messages -----------------------------------------------------------
// Track the latest mail id seen, for the /api/wait cursor below.
let latestId = 0;
if (inbox) {
  rows.push(
    await measure(
      'GET /api/inboxes/:addr/messages',
      async () => {
        const result = await fetchJson(`/api/inboxes/${encodeURIComponent(inbox.address)}/messages?limit=20`, {
          headers: inbox.token ? { Authorization: `Bearer ${inbox.token}` } : {},
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const results = result.body?.results ?? result.body?.messages ?? result.body?.mails;
        if (Array.isArray(results)) {
          for (const mail of results) {
            if (typeof mail?.id === 'number' && mail.id > latestId) latestId = mail.id;
          }
        }
        if (typeof result.body?.latest_id === 'number' && result.body.latest_id > latestId) {
          latestId = result.body.latest_id;
        }
        return result;
      },
      (s) => s.status === 200,
    ),
  );
} else {
  rows.push({
    label: 'GET /api/inboxes/:addr/messages',
    stats: null,
    attempted: N,
    errors: N,
    statuses: ['SKIP'],
    lastSample: null,
    note: 'skipped — no inbox could be created',
  });
}

// 5 — Wait (v2 only; 404 means v1 mode, not a failure) -------------------------
let waitMode = 'available'; // 'available' | 'v1' | 'skipped'
let waitRow = null;
if (inbox) {
  // Probe once via the measured samples themselves: if every sample is a
  // 404 the endpoint does not exist on this server.
  const waitSamplesS = [];
  const waitStatuses = [];
  let waitErrors = 0;
  let waitSaw404 = false;
  let waitLastBody = null;

  for (let i = 0; i < N; i += 1) {
    const sample = await timed(() =>
      fetchJson(
        `/api/wait?${new URLSearchParams({
          address: inbox.address,
          since_id: String(latestId),
          timeout: String(WAIT_TIMEOUT_S),
          timeout_seconds: String(WAIT_TIMEOUT_S),
        }).toString()}`,
        {
          headers: inbox.token ? { Authorization: `Bearer ${inbox.token}` } : {},
          signal: AbortSignal.timeout(WAIT_CLIENT_TIMEOUT_MS),
        },
      ),
    );
    waitLastBody = sample.body;
    waitStatuses.push(sample.status === null ? 'ERR' : sample.status);
    if (sample.status === 404) {
      waitSaw404 = true;
    } else if (!sample.error && sample.status === 200) {
      waitSamplesS.push(sample.ms / 1000);
    } else {
      waitErrors += 1;
    }
  }

  if (waitSaw404 && waitSamplesS.length === 0) {
    waitMode = 'v1';
    waitRow = {
      label: 'GET /api/wait (timeout path)',
      stats: null,
      attempted: N,
      errors: 0,
      statuses: waitStatuses,
      lastSample: null,
      note: 'v1 mode — /api/wait returned 404, endpoint not available (not a failure)',
    };
  } else {
    waitRow = {
      label: 'GET /api/wait (timeout path)',
      stats: stats(waitSamplesS),
      attempted: N,
      errors: waitErrors,
      statuses: waitStatuses,
      lastSample: null,
      note:
        waitLastBody && waitLastBody.timeout === true
          ? `timeout path confirmed (timeout:true, since_id=${latestId}, server wait ${WAIT_TIMEOUT_S}s)`
          : `since_id=${latestId}, server wait ${WAIT_TIMEOUT_S}s — check body: timeout flag not confirmed`,
    };
  }
  rows.push(waitRow);
} else {
  waitMode = 'skipped';
  rows.push({
    label: 'GET /api/wait (timeout path)',
    stats: null,
    attempted: N,
    errors: N,
    statuses: ['SKIP'],
    lastSample: null,
    note: 'skipped — no inbox could be created',
  });
}

// ---------------------------------------------------------------------------
// Report table
// ---------------------------------------------------------------------------

console.log('Results (seconds)');
console.log(
  `${pad('Endpoint', 36)} ${pad('n', 3)} ${pad('min', 8)} ${pad('median', 8)} ${pad('p95', 8)} ${pad('max', 8)} ${pad('mean', 8)} errors  statuses`,
);
console.log('-'.repeat(118));
for (const row of rows) {
  const st = row.stats;
  console.log(
    `${pad(row.label, 36)} ${pad(st ? st.count : 0, 3)} ${pad(fmtS(st?.min), 8)} ${pad(fmtS(st?.median), 8)} ${pad(fmtS(st?.p95), 8)} ${pad(fmtS(st?.max), 8)} ${pad(fmtS(st?.mean), 8)} ${pad(row.errors, 7)} ${row.statuses.join(',')}`,
  );
  if (row.note) console.log(`${pad('', 36)} note: ${row.note}`);
}
console.log('');

// ---------------------------------------------------------------------------
// VERDICT — comparison against v1 baselines
// ---------------------------------------------------------------------------

function compareMedian(label, medianS, baselineS) {
  if (medianS === null || medianS === undefined) {
    return { regressed: true, line: `REGRESSION? ${label}: no successful samples — cannot compare to v1 baseline ${fmtS(baselineS).trim()} median.` };
  }
  const delta = medianS - baselineS;
  const deltaPct = baselineS > 0 ? Math.round((delta / baselineS) * 100) : 0;
  const sign = delta >= 0 ? '+' : '';
  if (medianS > baselineS * (1 + REGRESSION_TOLERANCE)) {
    return {
      regressed: true,
      line: `REGRESSION  ${label}: median ${fmtS(medianS).trim()} vs v1 baseline ${fmtS(baselineS).trim()} (${sign}${delta.toFixed(3)}s, ${sign}${deltaPct}%).`,
    };
  }
  if (medianS < baselineS) {
    return {
      regressed: false,
      line: `OK (faster) ${label}: median ${fmtS(medianS).trim()} vs v1 baseline ${fmtS(baselineS).trim()} (${sign}${delta.toFixed(3)}s, ${sign}${deltaPct}%).`,
    };
  }
  return {
    regressed: false,
    line: `OK          ${label}: median ${fmtS(medianS).trim()} vs v1 baseline ${fmtS(baselineS).trim()} (${sign}${delta.toFixed(3)}s, ${sign}${deltaPct}%, within ${Math.round(REGRESSION_TOLERANCE * 100)}% tolerance).`,
  };
}

const byLabel = (prefix) => rows.find((r) => r.label.startsWith(prefix));
const healthVerdict = compareMedian('GET /api/health', byLabel('GET /api/health')?.stats?.median, BASELINES.healthMedianS);
const messagesVerdict = compareMedian(
  'GET /api/inboxes/:addr/messages',
  byLabel('GET /api/inboxes/:addr/messages')?.stats?.median,
  BASELINES.messagesMedianS,
);

let regressions = 0;
if (healthVerdict.regressed) regressions += 1;
if (messagesVerdict.regressed) regressions += 1;

console.log('VERDICT');
console.log('-------');
console.log(`v1 baselines: health median ${fmtS(BASELINES.healthMedianS).trim()}, messages median ${fmtS(BASELINES.messagesMedianS).trim()}, mail-visible worst case ${fmtS(BASELINES.mailVisibleWorstS).trim()} (polling).`);
console.log(healthVerdict.line);
console.log(messagesVerdict.line);

for (const row of rows) {
  if (row.errors > 0) {
    console.log(`WARNING     ${row.label}: ${row.errors}/${row.attempted} samples errored (statuses: ${row.statuses.join(',')}).`);
  }
}

if (waitMode === 'v1') {
  regressions += 1;
  console.log(
    `REGRESSION  mail-visible latency: /api/wait unavailable (v1 mode, 404) — clients must still poll, so the v1 worst case of ${fmtS(BASELINES.mailVisibleWorstS).trim()} between a mail landing and being seen still applies. No improvement over v1.`,
  );
} else if (waitMode === 'available' && waitRow?.stats) {
  const waitMedian = waitRow.stats.median;
  console.log(
    `OK          mail-visible latency: /api/wait is available — a waiting client is woken when mail lands instead of polling, so the v1 polling worst case of ${fmtS(BASELINES.mailVisibleWorstS).trim()} no longer applies. Timeout-path median measured at ${fmtS(waitMedian).trim()} for a ${WAIT_TIMEOUT_S}s server wait (expected: ~= the requested wait, confirming the long-poll holds instead of erroring or busy-looping).`,
  );
  if (waitMedian < WAIT_TIMEOUT_S * 0.5) {
    console.log(
      'WARNING     /api/wait returned much faster than the requested server wait on the timeout path — it may not be holding the request open. Check the timeout flag in its response body.',
    );
  }
} else {
  console.log('WARNING     mail-visible latency: /api/wait could not be measured (see table above) — no verdict against the v1 polling worst case.');
}

console.log(
  regressions === 0
    ? 'Overall: no regressions flagged against the v1 baselines.'
    : `Overall: ${regressions} regression(s) flagged against the v1 baselines — see lines marked REGRESSION above.`,
);
