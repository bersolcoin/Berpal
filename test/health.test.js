/**
 * GET /health (src/health.js) with injected db, fetch, scheduler and clock: status/HTTP code per
 * failure, ?deep=0 skipping external calls, and the request shapes sent to ERPNext and Twilio.
 *
 *   npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHealthHandler } = require('../src/health');
const { version } = require('../package.json');

const ENV = {
  ERPNEXT_URL: 'https://erp.example.com',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'tok',
};

function fakeRes() {
  return {
    code: 200,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

/** fetch stub: `responses` maps a URL prefix to a status code or an Error to throw. */
function fakeFetch(responses = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.startsWith(k));
    const r = key ? responses[key] : 200;
    if (r instanceof Error) throw r;
    return { ok: r >= 200 && r < 300, status: r };
  };
  return { impl, calls };
}

const okDb = { query: async () => ({ rows: [{ '?column?': 1 }] }) };
const downDb = { query: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); } };

async function call(opts, query = {}) {
  const handler = createHealthHandler({ env: ENV, scheduler: { running: () => true }, now: () => 0, ...opts });
  const res = fakeRes();
  await handler({ query }, res);
  return res;
}

// Silence the handler's failure logs.
const quiet = (fn) => async () => {
  const { warn, error } = console;
  console.warn = console.error = () => {};
  try { await fn(); } finally { Object.assign(console, { warn, error }); }
};

test('all ok → 200 ok, with version, uptime and every check', async () => {
  let t = 1000;
  const f = fakeFetch();
  const handler = createHealthHandler({ db: okDb, fetchImpl: f.impl, env: ENV, scheduler: { running: () => true }, now: () => t });
  t = 6000;
  const res = fakeRes();
  await handler({ query: {} }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.version, version);
  assert.equal(res.body.uptime_s, 5);
  assert.deepEqual(res.body.checks, {
    db: { ok: true, ms: 0 },
    erpnext: { ok: true, ms: 0 },
    twilio: { ok: true, ms: 0 },
    scheduler: { running: true },
  });

  const erp = f.calls.find((c) => c.url.startsWith('https://erp.example.com'));
  assert.equal(erp.url, 'https://erp.example.com/api/method/ping');
  assert.ok(erp.init.signal, 'ERPNext call has a timeout signal');
  const tw = f.calls.find((c) => c.url.startsWith('https://api.twilio.com'));
  assert.equal(tw.url, 'https://api.twilio.com/2010-04-01/Accounts/ACtest.json');
  assert.equal(tw.init.headers.Authorization, `Basic ${Buffer.from('ACtest:tok').toString('base64')}`);
  assert.ok(tw.init.signal, 'Twilio call has a timeout signal');
});

test('ERPNext down → 200 degraded with a detail', quiet(async () => {
  const f = fakeFetch({ 'https://erp.example.com': 502 });
  const res = await call({ db: okDb, fetchImpl: f.impl });
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.checks.erpnext.ok, false);
  assert.equal(res.body.checks.erpnext.detail, 'HTTP 502');
  assert.equal(res.body.checks.twilio.ok, true);
}));

test('ERPNext unreachable (network error) → degraded, raw error text not on the wire', quiet(async () => {
  // undici's messages can carry the URL (e.g. "Failed to parse URL from …"): only a fixed word goes out.
  const f = fakeFetch({ 'https://erp.example.com': new Error('Failed to parse URL from https://secret-host.internal/api') });
  const res = await call({ db: okDb, fetchImpl: f.impl });
  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.checks.erpnext.detail, 'unreachable');
  assert.ok(!JSON.stringify(res.body).includes('secret-host'));
}));

test('Twilio auth failing → 200 degraded, no detail on the wire', quiet(async () => {
  const f = fakeFetch({ 'https://api.twilio.com': 401 });
  const res = await call({ db: okDb, fetchImpl: f.impl });
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'degraded');
  assert.deepEqual(res.body.checks.twilio, { ok: false, ms: 0 });
}));

test('a hanging dependency times out instead of hanging the probe', quiet(async () => {
  const fetchImpl = (url) => (url.startsWith('https://erp') ? new Promise(() => {}) : Promise.resolve({ ok: true, status: 200 }));
  const res = await call({ db: okDb, fetchImpl, timeoutMs: 20 });
  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.checks.erpnext.detail, 'timeout');
}));

test('a timed-out fetch is actually aborted (socket released), not just abandoned', quiet(async () => {
  let signal;
  // Behaves like real fetch: rejects with the signal's reason once aborted.
  const fetchImpl = (url, init) => {
    if (!url.startsWith('https://erp')) return Promise.resolve({ ok: true, status: 200 });
    signal = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const res = await call({ db: okDb, fetchImpl, timeoutMs: 20 });
  assert.equal(res.body.checks.erpnext.detail, 'timeout');
  assert.equal(signal.aborted, true);
}));

test('response bodies are discarded so keep-alive sockets are reused', async () => {
  let cancelled = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, body: { cancel: async () => { cancelled += 1; } } });
  await call({ db: okDb, fetchImpl });
  assert.equal(cancelled, 2);
});

test('deep checks are cached and shared: a flood of /health costs one Twilio request per window', async () => {
  const f = fakeFetch();
  let t = 0;
  const handler = createHealthHandler({ db: okDb, fetchImpl: f.impl, env: ENV, now: () => t, deepCacheMs: 30000 });
  await Promise.all(Array.from({ length: 20 }, () => handler({ query: {} }, fakeRes())));
  t = 29999;
  await handler({ query: {} }, fakeRes());
  const twilioCalls = () => f.calls.filter((c) => c.url.startsWith('https://api.twilio.com')).length;
  assert.equal(twilioCalls(), 1);
  t = 30000;
  await handler({ query: {} }, fakeRes());
  assert.equal(twilioCalls(), 2);
});

test('db down → 503 fail, without the db error on the wire', quiet(async () => {
  const f = fakeFetch();
  const res = await call({ db: downDb, fetchImpl: f.impl });
  assert.equal(res.code, 503);
  assert.equal(res.body.status, 'fail');
  assert.deepEqual(res.body.checks.db, { ok: false, ms: 0 });
  assert.ok(!JSON.stringify(res.body).includes('10.0.0.5'));
}));

test('deep=0 skips ERPNext and Twilio entirely', async () => {
  const f = fakeFetch({ 'https://erp.example.com': 502, 'https://api.twilio.com': 401 });
  const res = await call({ db: okDb, fetchImpl: f.impl, scheduler: { running: () => false } }, { deep: '0' });
  assert.equal(f.calls.length, 0);
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'ok');
  assert.deepEqual(res.body.checks.erpnext, { ok: true, ms: 0, skipped: true });
  assert.deepEqual(res.body.checks.twilio, { ok: true, ms: 0, skipped: true });
  assert.deepEqual(res.body.checks.scheduler, { running: false });
});

test('deep=0 still fails on the db', quiet(async () => {
  const res = await call({ db: downDb, fetchImpl: fakeFetch().impl }, { deep: '0' });
  assert.equal(res.code, 503);
  assert.equal(res.body.status, 'fail');
}));

test('missing ERPNext / Twilio config → degraded, no fetch attempted', quiet(async () => {
  const f = fakeFetch();
  const res = await call({ db: okDb, fetchImpl: f.impl, env: {} });
  assert.equal(f.calls.length, 0);
  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.checks.erpnext.detail, 'ERPNEXT_URL not set');
}));
