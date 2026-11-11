/**
 * Putting the record straight for lot operations that stopped half way (src/lots/recover.js and
 * its nightly job): what is found in ERPNext is recorded, an operation whose documents are all
 * there is finished, one that never posted anything is closed, the rest waits for the trader.
 * Recovery reads ERPNext and never posts to it.
 *
 * A user has one unfinished operation at a time, so the steps run in order and each one leaves
 * nothing open behind it.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const db = require('../src/db');
const lots = require('../src/lots');
const store = require('../src/lots/store');
const execute = require('../src/lots/execute');
const recover = require('../src/lots/recover');
const job = require('../src/jobs/lots-recover.job');
const scheduler = require('../src/jobs/scheduler');

const { N, TODAY } = h;
const erp = new FakeErpNext();
let user; let client;
const ids = {};

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
});

/** Well past the age below which an operation may still be running. */
const later = () => new Date(Date.now() + 60 * 60000);
const lot = (code) => store.getLot(user.id, code);
const facts = (l) => l && [l.status, l.carats, l.cost, l.location];
const status = async (reference) => (await store.getOp(user.id, reference)).status;
const posts = () => erp.calls.filter((c) => c.method === 'POST').length;
const marked = (doctype, text) => erp.all(doctype).filter((d) => `${d.remarks || ''}${d.user_remark || ''}`.includes(text) && d.docstatus === 1);
const balance = async (account) => (await client.getAccountBalance(account, TODAY)).message;
const fee = (amount) => ({
  transaction_type: 'cash', direction: 'expense', currency: 'THB', transaction_date: TODAY, category_code: lots.FEE_CATEGORY_CODE,
  counterparty_name: N.CUTTER, counterparty_contact_skipped: true, amount, description: 'Cutting fee',
});

async function withFetch(hook, fn) {
  const real = global.fetch;
  global.fetch = (url, opts = {}) => hook(real, url, opts);
  try { return await fn(); } finally { global.fetch = real; }
}
const creates = (doctype, url, opts) => opts.method === 'POST' && decodeURIComponent(new URL(url).pathname) === `/api/resource/${doctype}`;
/** ERPNext takes the document, the answer never arrives. */
const lostAnswer = (doctype) => async (real, url, opts) => {
  const res = await real(url, opts);
  if (creates(doctype, url, opts)) throw new Error('The operation was aborted due to timeout');
  return res;
};
/** The request never reaches ERPNext. */
const neverSent = (doctype) => (real, url, opts) => (creates(doctype, url, opts) ? Promise.reject(new Error('fetch failed')) : real(url, opts));

test('nothing unfinished: nothing to do', async () => {
  assert.deepEqual(await recover.recoverUser(user, client, { now: later() }), []);
});

test('an operation that only just began is left alone; an old one that posted nothing is closed', async () => {
  const a1 = await h.seedLot(user, client, { code: 'A1', carats: 10, cost: 20000 });
  const begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'write_off', inputs: [h.input(a1, { carats: 1 })] }) });
  const before = erp.calls.length;
  // It may still be running: not even looked at.
  assert.deepEqual(await recover.recoverUser(user, client), []);
  assert.deepEqual(await recover.recoverUser(user, client, { now: later(), olderThanMinutes: 120 }), []);
  assert.equal(erp.calls.length, before);
  assert.equal(await status(begun.reference), 'pending');

  const n = posts();
  const out = await recover.recoverUser(user, client, { now: later() });
  assert.deepEqual(out.map((o) => [o.reference, o.action]), [[begun.reference, 'failed']]);
  assert.match(out[0].detail, /nothing was posted/);
  assert.equal(await status(begun.reference), 'failed');
  assert.equal(posts(), n);
  assert.deepEqual(await store.unfinishedOps(user.id), []);
  assert.deepEqual(facts(await lot('A1')), ['active', 10, 20000, 'stores']);
});

test('the last document is in ERPNext but was never recorded: it is found and the lots are updated', async () => {
  const b1 = await h.seedLot(user, client, { code: 'B1', carats: 30, cost: 60000 });
  const op = h.resolvedOp({
    kind: 'transform', job: 'cutting', inputs: [h.input(b1)],
    outputs: [h.output({ code: 'B2', carats: 9, cost: 60800, form: 'cut' })], fee: { amount: 800, capitalised: 800, basis: 'fixed' },
  });
  const r = await withFetch(lostAnswer('Stock Entry'), () => execute.run(user, client, { op, draft: fee(800) }));
  assert.deepEqual([r.ok, r.partial, r.docs.map((d) => d.doctype)], [false, true, ['Journal Entry']]);
  assert.equal(await lot('B2'), null);

  const n = posts();
  const out = await recover.recoverUser(user, client, { now: later() });
  assert.deepEqual(out.map((o) => [o.reference, o.action]), [[r.reference, 'posted']]);
  assert.match(out[0].detail, /found Stock Entry \S+; the lots are updated/);
  assert.equal(posts(), n, 'recovery posts nothing');
  assert.equal(await status(r.reference), 'posted');
  const row = await store.getOp(user.id, r.reference);
  assert.deepEqual(row.erpnext_docs.map((d) => [d.step, d.doctype]), [[1, 'Journal Entry'], [2, 'Stock Entry']]);
  assert.equal(row.erpnext_docs[1].name, marked('Stock Entry', r.reference)[0].name);
  assert.deepEqual(facts(await lot('B2')), ['active', 9, 60800, 'stores']);
  assert.deepEqual(facts(await lot('B1')).slice(0, 3), ['closed', 0, 0]);
  assert.equal(await balance(N.VALUATION), 0);
  assert.deepEqual(await recover.recoverUser(user, client, { now: later() }), []);
});

test('the fee is in ERPNext unrecorded and the Repack is not there: the fee is recorded, the rest waits for the trader', async () => {
  const c1 = await h.seedLot(user, client, { code: 'C1', carats: 20, cost: 40000 });
  const op = h.resolvedOp({
    kind: 'transform', job: 'cutting', inputs: [h.input(c1)],
    outputs: [h.output({ code: 'C2', carats: 6, cost: 40500, form: 'cut' })], fee: { amount: 500, capitalised: 500, basis: 'fixed' },
  });
  const r = await withFetch(lostAnswer('Journal Entry'), () => execute.run(user, client, { op, draft: fee(500) }));
  assert.deepEqual([r.ok, r.partial, r.docs], [false, true, []]);

  const n = posts();
  let out = await recover.recoverUser(user, client, { now: later() });
  assert.deepEqual(out.map((o) => [o.reference, o.action]), [[r.reference, 'recorded']]);
  assert.match(out[0].detail, /found Journal Entry \S+; step 2 of 2 is not in ERPNext/);
  const row = await store.getOp(user.id, r.reference);
  assert.deepEqual([row.status, row.erpnext_docs.map((d) => [d.step, d.doctype])], ['partial', [[1, 'Journal Entry']]]);
  assert.equal(row.erpnext_docs[0].name, marked('Journal Entry', r.reference)[0].name);

  // Nothing more to find the next night: it waits, and still nothing is posted.
  out = await recover.recoverUser(user, client, { now: later() });
  assert.deepEqual(out.map((o) => o.action), ['waiting']);
  assert.match(out[0].detail, /step 2 of 2 is not in ERPNext/);
  // ERPNext down: it waits too, and says why.
  out = await withFetch(async () => { throw new Error('connect ECONNREFUSED'); }, () => recover.recoverUser(user, client, { now: later() }));
  assert.deepEqual(out.map((o) => o.action), ['waiting']);
  assert.match(out[0].detail, /ECONNREFUSED/);
  assert.equal(posts(), n);
  assert.equal(await status(r.reference), 'partial');
  assert.deepEqual(facts(await lot('C1')), ['active', 20, 40000, 'stores']);

  // The trader retries: only the Repack is posted.
  const again = await execute.run(user, client, { reference: r.reference });
  assert.equal(again.ok, true, again.error);
  assert.equal(marked('Journal Entry', r.reference).length, 1);
  assert.deepEqual(facts(await lot('C2')), ['active', 6, 40500, 'stores']);
});

test('every document was recorded and only the lot rows are behind: finished', async () => {
  const d1 = await h.seedLot(user, client, { code: 'D1', carats: 8, cost: 16000 });
  const op = h.resolvedOp({ kind: 'split', inputs: [h.input(d1)], outputs: [h.output({ code: 'D2', carats: 3, cost: 6000 }), h.output({ code: 'D3', carats: 5, cost: 10000 })] });
  const busy = (real, url, opts) => (decodeURIComponent(url).includes('/api/resource/Stock Ledger Entry')
    ? { ok: false, status: 503, text: async () => JSON.stringify({ exception: 'busy' }) } : real(url, opts));
  const r = await withFetch(busy, () => execute.run(user, client, { op }));
  assert.deepEqual([r.ok, r.partial, r.docs.length], [false, true, 1]);

  // Still not readable: it stays as it is.
  let out = await withFetch(busy, () => recover.recoverUser(user, client, { now: later() }));
  assert.deepEqual(out.map((o) => o.action), ['waiting']);
  assert.equal(await status(r.reference), 'partial');

  const n = posts();
  out = await recover.recoverUser(user, client, { now: later() });
  assert.deepEqual(out.map((o) => [o.reference, o.action]), [[r.reference, 'posted']]);
  assert.match(out[0].detail, /every document was recorded/);
  assert.equal(posts(), n);
  assert.deepEqual(facts(await lot('D2')), ['active', 3, 6000, 'stores']);
  assert.deepEqual(facts(await lot('D3')), ['active', 5, 10000, 'stores']);
});

test('a request that may or may not have arrived, and did not: it waits (only the trader closes or retries it)', async () => {
  const d2 = await lot('D2');
  const op = h.resolvedOp({ kind: 'write_off', reason: 'lost', inputs: [h.input(d2, { carats: 1 })] });
  const r = await withFetch(neverSent('Stock Entry'), () => execute.run(user, client, { op }));
  assert.deepEqual([r.ok, r.partial, r.docs], [false, true, []]);
  const out = await recover.recoverUser(user, client, { now: later() });
  assert.deepEqual(out.map((o) => [o.reference, o.action]), [[r.reference, 'waiting']]);
  assert.match(out[0].detail, /step 1 of 1 is not in ERPNext/);
  assert.equal(await status(r.reference), 'partial');
  ids.waiting = r.reference;
});

test('the nightly job: gem traders only, quiet when there is nothing, counts what it did', async () => {
  assert.equal(job.name, 'lots-recover');
  assert.equal(job.enabled(user), true);
  assert.equal(job.enabled({ id: 99, niche: null }), false);
  assert.ok(scheduler.loadJobs().some((j) => j.name === 'lots-recover' && j.defaultTime === '02:00'));

  // Young: left alone, the run counts as skipped.
  assert.deepEqual(await job.run(user, { erp: client, now: new Date(Date.now() - 60000) }), { skipped: true, note: 'no unfinished stock operation' });
  let r = await job.run(user, { erp: client, now: later() });
  assert.deepEqual(r, { operations: 1, posted: 0, failed: 0, recorded: 0, waiting: 1, note: `${ids.waiting} waiting` });

  // The trader retries; the next night has nothing to do.
  const again = await execute.run(user, client, { reference: ids.waiting });
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(await job.run(user, { erp: client, now: later() }), { skipped: true, note: 'no unfinished stock operation' });

  // A crash before the first request: closed by the job.
  const begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'write_off', inputs: [h.input(await lot('D3'), { carats: 1 })] }) });
  r = await job.run(user, { erp: client, now: later() });
  assert.deepEqual(r, { operations: 1, posted: 0, failed: 1, recorded: 0, waiting: 0, note: `${begun.reference} failed` });
  assert.equal(await status(begun.reference), 'failed');
});

test('an operation that is being undone belongs to the undo: not touched', async () => {
  const begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'write_off', inputs: [h.input(await lot('D3'), { carats: 1 })] }) });
  await store.markUndoing(begun.id);
  const before = erp.calls.length;
  assert.deepEqual(await recover.recoverUser(user, client, { now: later() }), []);
  assert.deepEqual(await job.run(user, { erp: client, now: later() }), { skipped: true, note: 'no unfinished stock operation' });
  assert.equal(erp.calls.length, before);
  assert.equal(await status(begun.reference), 'undoing');
  await db.query("UPDATE lot_ops SET status = 'failed' WHERE id = $1", [begun.id]);
});

test('another trader\'s unfinished operation is not this one\'s business', async () => {
  const other = await h.addUser({ niche: 'gems', phone: '+66800000777' });
  const begun = await store.beginOp(other, { op: h.resolvedOp({ kind: 'write_off', inputs: [h.input(await lot('D3'), { carats: 1 })] }) });
  assert.deepEqual(await recover.recoverUser(user, client, { now: later() }), []);
  assert.equal((await store.getOpById(begun.id)).status, 'pending');
  const out = await recover.recoverUser(other, client, { now: later() });
  assert.deepEqual(out.map((o) => o.action), ['failed']);
});
