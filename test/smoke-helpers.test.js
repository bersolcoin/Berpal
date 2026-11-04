/**
 * Pure helpers behind scripts/smoke-erpnext.js (the script itself needs a real ERPNext).
 *
 *   npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../scripts/lib/smoke-helpers');

test('parseArgs: modes, flags, values and mistakes', () => {
  const d = H.parseArgs([]);
  assert.deepEqual(
    [d.mode, d.fix, d.allowLive, d.cleanup, d.keep, d.company, d.report, d.help, d.errors],
    ['full', false, false, false, false, null, './smoke-report.json', false, []]
  );
  assert.equal(H.parseArgs(['--preflight']).mode, 'preflight');
  assert.equal(H.parseArgs(['--cleanup-only']).mode, 'cleanup');
  const o = H.parseArgs(['--fix', '--allow-live', '--cleanup', '--company', 'Smoke Co', '--report=out/r.json']);
  assert.deepEqual([o.fix, o.allowLive, o.cleanup, o.company, o.report, o.errors], [true, true, true, 'Smoke Co', 'out/r.json', []]);
  assert.equal(H.parseArgs(['-h']).help, true);

  assert.match(H.parseArgs(['--company']).errors[0], /needs a value/);
  assert.match(H.parseArgs(['--company', '--fix']).errors[0], /needs a value/);
  assert.match(H.parseArgs(['--nope']).errors[0], /unknown argument --nope/);
  assert.match(H.parseArgs(['--cleanup', '--keep']).errors[0], /contradict/);
  assert.match(H.parseArgs(['--preflight', '--cleanup']).errors[0], /--cleanup-only/);
});

test('sameValue / check: numeric tolerance, deep compare, soft checks', () => {
  assert.equal(H.sameValue(44600, 44600.004), true);
  assert.equal(H.sameValue(44600, 44600.01), false);
  assert.equal(H.sameValue(1070, '1070.00'), true, 'Frappe sometimes returns numeric strings');
  assert.equal(H.sameValue('2026-10-15', '2026-10-15'), true);
  assert.equal(H.sameValue(null, null), true);
  assert.equal(H.sameValue(null, 0), false);
  assert.equal(H.sameValue([['VAT 7%', 'Add', 700]], [['VAT 7%', 'Add', 700.0]]), true);
  assert.equal(H.sameValue([1, 2], [1]), false);
  assert.equal(H.sameValue({ THB: 3000 }, { THB: 3000, USD: 0 }), true, 'a zero extra key is no difference');
  assert.equal(H.sameValue({}, { USD: 5 }), false);

  assert.deepEqual(H.check('outstanding', 0, 0.001), { label: 'outstanding', ok: true, expected: 0, actual: 0.001 });
  assert.equal(H.check('rate', 32.5, 32.5000001, { tol: 1e-6 }).ok, true);
  assert.deepEqual(H.check('fx', 1, 2, { soft: true }).soft, true);
  assert.equal(H.checkThat('pdf', false, '%PDF-', 'html').ok, false);
});

test('glNet / compareGl: nets per account, extra balances are differences', () => {
  const rows = [
    { account: 'Debtors - TC', debit: 1070, credit: 0 },
    { account: 'Sales - TC', debit: 0, credit: 1000 },
    { account: 'Output VAT - TC', debit: 0, credit: 70 },
    { account: 'Round Off - TC', debit: 0.004, credit: 0 },
  ];
  const net = H.glNet(rows);
  assert.deepEqual(net, { 'Debtors - TC': 1070, 'Sales - TC': -1000, 'Output VAT - TC': -70 });
  assert.deepEqual(H.compareGl({ 'Debtors - TC': 1070, 'Sales - TC': -1000, 'Output VAT - TC': -70 }, net), { ok: true, diffs: [] });

  const off = H.compareGl({ 'Debtors - TC': 1070, 'Sales - TC': -1000.01 }, { ...net, 'Round Off - TC': 0.01, 'Sales - TC': -1000.01 });
  assert.equal(off.ok, false);
  assert.deepEqual(off.diffs, [
    { account: 'Output VAT - TC', expected: 0, actual: -70 },
    { account: 'Round Off - TC', expected: 0, actual: 0.01 },
  ]);
  const c = H.checkGl('GL', { A: 1 }, { A: 2 });
  assert.deepEqual([c.ok, c.diffs], [false, [{ account: 'A', expected: 1, actual: 2 }]]);
});

test('serverMessage: _server_messages, exception, raw HTML, plain errors', () => {
  const sm = (msgs, extra = {}) => Object.assign(new Error('[erpnext POST /api/resource/Payment Entry] …'), {
    status: 417, response: { _server_messages: JSON.stringify(msgs.map((m) => JSON.stringify({ message: m }))), ...extra },
  });
  assert.equal(
    H.serverMessage(sm(['Reference No is mandatory if you entered <b>Reference Date</b>'])),
    'HTTP 417: Reference No is mandatory if you entered Reference Date'
  );
  assert.equal(
    H.serverMessage(sm(['Row 1: a', 'Row 1: a'], { exception: 'frappe.exceptions.ValidationError: Row 1: a' })),
    'HTTP 417: Row 1: a | frappe.exceptions.ValidationError: Row 1: a'
  );
  const exc = Object.assign(new Error('x'), { status: 404, response: { exc_type: 'DoesNotExistError' } });
  assert.equal(H.serverMessage(exc), 'HTTP 404: DoesNotExistError');
  const raw = Object.assign(new Error('x'), { status: 502, response: { raw: '<html><body><h1>Bad Gateway</h1></body></html>' } });
  assert.equal(H.serverMessage(raw), 'HTTP 502: Bad Gateway');
  assert.equal(H.serverMessage(new Error('wallet 3 not found or inactive')), 'wallet 3 not found or inactive');
  assert.equal(H.serverMessage(Object.assign(new Error('x'), { response: { _server_messages: 'not json' } })), 'not json');
});

test('roundingStatus: legacy passes, others warn, missing field is pre-v15 legacy', () => {
  assert.equal(H.roundingStatus("Banker's Rounding (legacy)").status, 'PASS');
  assert.equal(H.roundingStatus(undefined).status, 'PASS');
  assert.equal(H.roundingStatus("Banker's Rounding").status, 'WARN');
  assert.equal(H.roundingStatus('Commercial Rounding').status, 'WARN');
});

test('liveGuardDecision: refuses foreign GL Entries unless --allow-live', () => {
  assert.deepEqual(H.liveGuardDecision({ total: 0 }).ok, true);
  const rerun = H.liveGuardDecision({ total: 120, smoke: 120 });
  assert.deepEqual([rerun.ok, rerun.foreign], [true, 0]);
  assert.match(rerun.message, /earlier smoke runs/);
  const live = H.liveGuardDecision({ total: 5000, smoke: 120 });
  assert.deepEqual([live.ok, live.foreign], [false, 4880]);
  assert.match(live.message, /--allow-live/);
  assert.equal(H.liveGuardDecision({ total: 5000, smoke: 0, allowLive: true }).ok, true);
});

test('cleanupOrder: payments, then invoices (newest first), JEs, files, items, parties, accounts', () => {
  const created = [
    { doctype: 'Account', name: 'SMOKE-Cash - TC' },
    { doctype: 'Journal Entry', name: 'JV-1' },
    { doctype: 'Customer', name: 'SMOKE-Jameel' },
    { doctype: 'Sales Invoice', name: 'SINV-1' },
    { doctype: 'Payment Entry', name: 'PAY-1' },
    { doctype: 'Purchase Invoice', name: 'PINV-STOCK' },
    { doctype: 'Item', name: 'SMOKEPA2293-TC' },
    { doctype: 'Sales Invoice', name: 'SINV-STOCK' },
    { doctype: 'File', name: 'f1' },
    { doctype: 'Payment Entry', name: 'PAY-1' }, // duplicate
    { doctype: 'Journal Entry', name: 'JV-FX', auto: true },
    { doctype: 'Customer', name: null },
  ];
  assert.deepEqual(H.cleanupOrder(created).map((c) => c.name), [
    'PAY-1', 'SINV-STOCK', 'PINV-STOCK', 'SINV-1', 'JV-FX', 'JV-1', 'f1', 'SMOKEPA2293-TC', 'SMOKE-Jameel', 'SMOKE-Cash - TC',
  ]);
  assert.equal(H.isSubmittable('Payment Entry'), true);
  assert.equal(H.isSubmittable('Item'), false);
});

test('formatCheck / formatPreflight: one line per result, expected vs actual on failure', () => {
  assert.equal(H.formatCheck({ label: 'outstanding', ok: true }), '  ✔ outstanding');
  assert.equal(H.formatCheck({ label: 'outstanding', ok: false, expected: 44600, actual: 45000 }), '  ✖ outstanding — expected 44600, actual 45000');
  assert.match(H.formatCheck({ label: 'fx', ok: false, soft: true, expected: 1, actual: 2 }), /^ {2}⚠ fx/);
  assert.match(H.formatCheck(H.checkGl('GL', { A: 1 }, { A: 2 })), /differs: A exp 1 got 2/);
  assert.match(H.formatPreflight({ status: 'FAIL', label: 'Exchange Gain/Loss Account', detail: '(unset)', hint: 'set it' }), /FAIL .*\(unset\)\n +→ set it/);
  assert.doesNotMatch(H.formatPreflight({ status: 'PASS', label: 'x', detail: 'y', hint: 'never shown' }), /never shown/);
});

test('buildReport: shape, summary counts and the failure flag', () => {
  const steps = [
    { id: 'a', label: 'wallets', ok: true, checks: [H.check('x', 1, 1), H.check('dup', {}, { a: 1 }, { soft: true })], docs: { cash: 'SMOKE-Cash - TC' } },
    { id: 'f', label: 'payments', ok: false, checks: [H.check('outstanding', 0, 400)], error: { message: 'm', server: 's', status: 417 } },
    { id: 'l', label: 'pdf', ok: false, skipped: 'needs sinvFx', checks: [] },
  ];
  const r = H.buildReport({
    startedAt: 't0', finishedAt: 't1', mode: 'full', options: { fix: true, allowLive: false, cleanup: false, keep: true },
    target: { url: 'https://erp.test', company: 'Smoke Co' }, preflight: [{ status: 'PASS' }, { status: 'WARN' }],
    steps, created: [{ doctype: 'Account', name: 'SMOKE-Cash - TC' }], cleanup: { removed: [1], failed: [] },
  });
  assert.deepEqual(r.options, { fix: true, allow_live: false, cleanup: false, keep: true });
  assert.deepEqual(r.summary, {
    preflight: { pass: 1, warn: 1, fail: 0 },
    steps: { ok: 1, failed: 1, skipped: 1 },
    checks: { passed: 1, failed: 1, soft_failed: 1 },
    cleanup: { removed: 1, failed: 0 },
    failed: true,
  });
  assert.equal(r.steps[0].docs.cash, 'SMOKE-Cash - TC');
  assert.equal(r.steps[2].skipped, 'needs sinvFx');
  assert.equal(r.steps[1].error.server, 's');
  assert.equal(JSON.stringify(r).includes('api_key'), false);

  const clean = H.summarize({ preflight: [{ status: 'WARN' }], steps: [{ ok: true, checks: [H.check('soft', 1, 2, { soft: true })] }] });
  assert.equal(clean.failed, false, 'warnings and soft checks never fail the run');
  assert.equal(H.summarize({ preflight: [{ status: 'FAIL' }] }).failed, true);
});

test('addDays crosses month ends in UTC', () => {
  assert.equal(H.addDays('2026-11-04', -20), '2026-10-15');
  assert.equal(H.addDays('2026-01-31', 30), '2026-03-02');
});
