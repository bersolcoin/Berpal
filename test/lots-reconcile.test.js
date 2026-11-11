/**
 * The nightly comparison of Berpal's lots with ERPNext (src/lots/reconcile.js, migration 110,
 * src/jobs/lots-reconcile.job.js): clean books, each kind of mismatch, and how the findings are
 * kept (opened once, refreshed, closed when no longer found).
 *
 * One gems user against one fake company; the tests build on each other in file order.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const db = require('../src/db');
const store = require('../src/lots/store');
const reconcile = require('../src/lots/reconcile');
const job = require('../src/jobs/lots-reconcile.job');
const scheduler = require('../src/jobs/scheduler');

const { N, TODAY } = h;
const erp = new FakeErpNext();
let user; let client;
let issue; // the Material Issue the accountant made outside Berpal

const lot = (code) => store.getLot(user.id, code);
const rows = () => db.query('SELECT * FROM lot_mismatches WHERE user_id = $1 ORDER BY id', [user.id]).then((r) => r.rows);
const brief = (list) => list.map((m) => [m.kind, m.lot, m.berpal, m.erpnext]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
const counts = () => ['Stock Entry', 'Stock Ledger Entry', 'GL Entry', 'Journal Entry', 'Batch', 'Comment'].map((d) => erp.all(d).length);
/** The client with one read made to fail, to see what a run does when ERPNext does not answer. */
const failing = (method, when) => {
  const broken = Object.create(client);
  broken[method] = async (...args) => { if (when(...args)) throw new Error('[erpnext GET /x] 503 gateway timeout'); return client[method](...args); };
  return broken;
};

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
  await h.seedLot(user, client, { code: 'R1', carats: 100, cost: 50000, pieces: 20 });
  await h.seedLot(user, client, { code: 'R2', carats: 40, cost: 20000 });
  await h.seedLot(user, client, { code: 'R3', carats: 30, cost: 9000, location: 'work', holder: N.CUTTER });
  await h.seedLot(user, client, { code: 'R5', carats: 6, cost: 600 });

  // A cut with its fee, on both sides: the fee goes through the holding account and out again.
  const r6 = await h.seedLot(user, client, { code: 'R6', carats: 120, cost: 270000 });
  const fee = await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: N.VALUATION, debit_in_account_currency: 2400 }, { account: N.CASH, credit_in_account_currency: 2400 }],
  });
  await client.createResource('Batch', { batch_id: 'R7-TC', item: N.CUT });
  const repack = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 120, s_warehouse: N.STORES, batch_no: 'R6-TC' }),
    h.valued({ item_code: N.CUT, qty: 30, t_warehouse: N.STORES, batch_no: 'R7-TC', basic_amount: 270000 }),
  ], { additional_costs: [{ expense_account: N.VALUATION, description: 'Cutting fee', amount: 2400 }] });
  await h.recordPosted(user, h.resolvedOp({
    kind: 'transform', job: 'cutting', fee: { amount: 2400, capitalised: 2400, basis: 'fixed' },
    inputs: [h.input(r6)], outputs: [h.output({ code: 'R7', carats: 30, pieces: 42, cost: 272400, form: 'cut' })],
  }), { docs: [{ doctype: 'Journal Entry', name: fee.data.name }, { doctype: 'Stock Entry', name: repack.name }] });
});

// ── clean ──────────────────────────────────────────────────────────────

test('clean books: nothing found, nothing kept, and nothing written anywhere', async () => {
  const was = [counts(), await lot('R1'), await lot('R7')];
  const from = erp.calls.length;
  const r = await reconcile.run(user, client);
  assert.deepEqual(r, { checked: 5, mismatches: [], opened: 0, closed: 0 });
  assert.deepEqual(await reconcile.open(user), []);
  assert.deepEqual(await rows(), []);
  assert.deepEqual([counts(), await lot('R1'), await lot('R7')], was);
  // Reads only: lists, and the balance of the holding account.
  const sent = erp.calls.slice(from);
  assert.ok(sent.length > 0);
  assert.ok(sent.every((c) => c.method === 'GET' || /get_balance_on/.test(c.url)), 'only reads go to ERPNext');

  assert.deepEqual(await job.run(user, { erp: client }), { checked: 5, mismatches: 0, note: 'clean' });
});

// ── each kind of mismatch ──────────────────────────────────────────────

test('carats, place, value, holding, and stones ERPNext holds that Berpal has no lot for', async () => {
  // carats (and with them value): 10 ct of R1 issued straight in ERPNext
  issue = await h.stockEntry(client, 'Material Issue', [h.row({ item_code: N.ROUGH, qty: 10, s_warehouse: N.STORES, batch_no: 'R1-TC' })]);
  // place: R2 moved to the work warehouse in ERPNext only
  await h.stockEntry(client, 'Material Transfer', [h.row({ item_code: N.ROUGH, qty: 40, s_warehouse: N.STORES, t_warehouse: N.WORK, batch_no: 'R2-TC' })]);
  // value only: R4 is 10 ct on both sides, at 1,000 in Berpal and 1,200 in ERPNext
  await client.createResource('Batch', { batch_id: 'R4-TC', item: N.ROUGH });
  await h.stockEntry(client, 'Material Receipt', [h.row({ item_code: N.ROUGH, qty: 10, t_warehouse: N.STORES, batch_no: 'R4-TC', basic_amount: 1200, expense_account: N.EQUITY })]);
  await h.recordPosted(user, h.resolvedOp({ kind: 'buy', counterparty: N.SUPPLIER, outputs: [h.output({ code: 'R4', carats: 10, cost: 1000 })] }));
  // holding: a fee booked to the holding account that never went into any stones
  await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: N.VALUATION, debit_in_account_currency: 500 }, { account: N.CASH, credit_in_account_currency: 500 }],
  });
  // no lot: a batch of rough received in ERPNext that Berpal never heard of
  await client.createResource('Batch', { batch_id: 'X9-TC', item: N.ROUGH });
  await h.stockEntry(client, 'Material Receipt', [h.row({ item_code: N.ROUGH, qty: 7, t_warehouse: N.STORES, batch_no: 'X9-TC', basic_amount: 700, expense_account: N.EQUITY })]);
  // a lot Berpal has closed (written off) while ERPNext still holds it
  await h.recordPosted(user, h.resolvedOp({ kind: 'write_off', reason: 'lost', inputs: [h.input(await lot('R5'))] }));
  assert.equal((await lot('R5')).status, 'closed');

  const before = [await lot('R1'), await lot('R2'), await lot('R4')];
  const r = await reconcile.run(user, client);
  assert.equal(r.checked, 5); // R1 R2 R3 R4 R7 (R5 and R6 are closed)
  assert.deepEqual(brief(r.mismatches), [
    ['carats', 'R1', 100, 90],
    ['carats', 'R5', 0, 6],
    ['holding', null, 0, 500],
    ['no_lot', null, 0, 7],
    ['place', 'R2', 'stores', 'work'],
    ['value', 'R1', 50000, 45000],
    ['value', 'R4', 1000, 1200],
  ]);
  assert.deepEqual([r.opened, r.closed], [7, 0]);
  const detail = (kind, code) => r.mismatches.find((m) => m.kind === kind && m.lot === code).detail;
  assert.equal(detail('carats', 'R1'), 'Lot R1: Berpal has 100 ct, ERPNext has 90 ct in batch R1-TC.');
  assert.equal(detail('carats', 'R5'), 'Lot R5: Berpal has nothing left of it, ERPNext still holds 6 ct in batch R5-TC.');
  assert.equal(detail('place', 'R2'), `Lot R2: Berpal has it in stock, ERPNext holds 40 ct in ${N.WORK}.`);
  assert.equal(detail('value', 'R4'), 'Lot R4: Berpal carries it at 1,000 THB, ERPNext values batch R4-TC at 1,200 THB.');
  assert.equal(detail('no_lot', null), `ERPNext holds 7 ct of ${N.ROUGH} in batch X9-TC, which Berpal has no lot for.`);
  assert.match(detail('holding', null), /^5118 - Expenses Included In Valuation - TC shows 500 THB and should be back at zero/);
  assert.deepEqual(Object.keys(r.mismatches[0]), ['lot', 'kind', 'berpal', 'erpnext', 'detail']);
  // It reports; the lots are as they were.
  assert.deepEqual([await lot('R1'), await lot('R2'), await lot('R4')], before);
});

// ── how the findings are kept ──────────────────────────────────────────

test('open(): the findings of the last run; a second run repeats none of them', async () => {
  const first = await reconcile.open(user);
  assert.deepEqual(brief(first), [
    ['carats', 'R1', 100, 90], ['carats', 'R5', 0, 6], ['holding', null, 0, 500], ['no_lot', null, 0, 7],
    ['place', 'R2', 'stores', 'work'], ['value', 'R1', 50000, 45000], ['value', 'R4', 1000, 1200],
  ]);
  assert.ok(first.every((m) => Number.isInteger(m.id) && m.detail && m.first_seen === m.last_seen));

  await new Promise((r) => setTimeout(r, 5));
  const again = await reconcile.run(user, client);
  assert.deepEqual([again.mismatches.length, again.opened, again.closed], [7, 0, 0]);
  const second = await reconcile.open(user);
  assert.deepEqual(second.map((m) => [m.id, m.first_seen]), first.map((m) => [m.id, m.first_seen]));
  assert.ok(second.every((m) => m.last_seen > m.first_seen), 'last_seen moves on');
  assert.equal((await rows()).length, 7);
  assert.deepEqual(await reconcile.open(await h.addUser()), [], 'another user has none');
});

test('a finding that is no longer found is closed; one that changed stays the same row', async () => {
  const was = await reconcile.open(user);
  await client.cancelDoc('Stock Entry', issue.name); // the accountant takes the issue back
  // and books another 100 to the holding account
  await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: N.VALUATION, debit_in_account_currency: 100 }, { account: N.CASH, credit_in_account_currency: 100 }],
  });
  const r = await reconcile.run(user, client);
  assert.deepEqual([r.mismatches.length, r.opened, r.closed], [5, 0, 2]);
  const now = await reconcile.open(user);
  assert.deepEqual(brief(now), [
    ['carats', 'R5', 0, 6], ['holding', null, 0, 600], ['no_lot', null, 0, 7], ['place', 'R2', 'stores', 'work'], ['value', 'R4', 1000, 1200],
  ]);
  const holding = (list) => list.find((m) => m.kind === 'holding');
  assert.equal(holding(now).id, holding(was).id);
  assert.match(holding(now).detail, /shows 600 THB/);
  const closed = (await rows()).filter((x) => x.status === 'closed');
  assert.deepEqual(closed.map((x) => [x.kind, x.lot_code]).sort(), [['carats', 'R1'], ['value', 'R1']]);
  assert.ok(closed.every((x) => x.closed_at));

  // The same thing going wrong again later is a new finding, not the old one reopened.
  issue = await h.stockEntry(client, 'Material Issue', [h.row({ item_code: N.ROUGH, qty: 10, s_warehouse: N.STORES, batch_no: 'R1-TC' })]);
  const back = await reconcile.run(user, client);
  assert.deepEqual([back.opened, back.closed], [2, 0]);
  assert.equal((await rows()).length, 9);
  assert.equal((await reconcile.open(user)).length, 7);
});

test('when ERPNext cannot be read nothing is kept or closed; a check that could not run closes nothing it covers', async () => {
  const was = await rows();
  await assert.rejects(reconcile.run(user, failing('listResource', (doctype) => doctype === 'Stock Ledger Entry')), /503/);
  assert.deepEqual(await rows(), was);

  // The holding account is an extra: without it the lots are still compared, and what was open about it stays open.
  const noBalance = await reconcile.run(user, failing('getAccountBalance', () => true));
  assert.equal(noBalance.mismatches.some((m) => m.kind === 'holding'), false);
  assert.deepEqual([noBalance.opened, noBalance.closed], [0, 0]);
  assert.deepEqual((await rows()).map((x) => [x.id, x.status]), was.map((x) => [x.id, x.status]));
  assert.ok((await reconcile.open(user)).some((m) => m.kind === 'holding'));

  // The list of batches is an extra: without it the lots are still compared. What only that list
  // shows stays as it was: the open 'no_lot' finding, and the stones of R5, a lot Berpal closed.
  const r = await reconcile.run(user, failing('listResource', (doctype) => doctype === 'Batch'));
  assert.equal(r.mismatches.some((m) => m.kind === 'no_lot'), false);
  assert.equal(r.mismatches.some((m) => m.kind === 'carats' && m.lot === 'R5'), false);
  assert.deepEqual([r.opened, r.closed], [0, 0]);
  assert.deepEqual((await rows()).map((x) => [x.id, x.status]), was.map((x) => [x.id, x.status]));
  assert.ok((await reconcile.open(user)).some((m) => m.kind === 'no_lot'));
  assert.ok((await reconcile.open(user)).some((m) => m.kind === 'carats' && m.lot === 'R5'));
  const full = await reconcile.run(user, client);
  assert.deepEqual([full.mismatches.length, full.opened, full.closed], [7, 0, 0], 'nothing flapped: no finding was closed and reopened');
});

// ── the job ────────────────────────────────────────────────────────────

test('the job: for gem traders only, nightly, quiet when clean, skipped while an operation is unfinished', async () => {
  assert.equal(job.name, 'lots-reconcile');
  assert.match(job.defaultTime, /^0[0-5]:\d\d$/);
  assert.equal(job.enabled(user), true);
  assert.equal(job.enabled(await h.addUser({ niche: null })), false);
  assert.ok(scheduler.loadJobs().some((j) => j.name === 'lots-reconcile'));

  const r = await job.run(user, { erp: client });
  assert.deepEqual({ ...r, kinds: [...r.kinds].sort(), note: null }, {
    checked: 5, mismatches: 7, opened: 0, closed: 0, kinds: ['carats', 'holding', 'no_lot', 'place', 'value'], note: null,
  });
  assert.match(r.note, /7/);

  const begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'write_off', reason: 'lost', inputs: [h.input(await lot('R3'))] }) });
  const calls = erp.calls.length;
  assert.deepEqual(await job.run(user, { erp: client }), { skipped: true, note: `stock operation ${begun.reference} is not finished` });
  assert.equal(erp.calls.length, calls, 'ERPNext is not asked while an operation is unfinished');
  assert.equal((await reconcile.open(user)).length, 7, 'and the open findings stay');
  await store.failOp(begun.id, 'dropped by the test');
  assert.equal((await job.run(user, { erp: client })).mismatches, 7);
});

// ── what a run did not check stays as it was ───────────────────────────

test('a lot ERPNext could not be asked about keeps its open finding; the others are still compared', async () => {
  const open = await reconcile.open(user);
  const r4 = open.find((m) => m.kind === 'value' && m.lot === 'R4');
  assert.ok(r4);
  const r = await reconcile.run(user, failing('listResource', (doctype, opts) => doctype === 'Stock Ledger Entry' && JSON.stringify(opts.filters).includes('R4-TC')));
  assert.deepEqual(r.unchecked, ['R4']);
  assert.equal(r.checked, 4);
  assert.equal(r.mismatches.some((m) => m.lot === 'R4'), false, 'nothing is said about R4 tonight');
  assert.deepEqual([r.opened, r.closed], [0, 0]);
  const now = await reconcile.open(user);
  assert.equal(now.length, open.length);
  assert.equal(now.find((m) => m.id === r4.id).last_seen, r4.last_seen, 'and the finding is not touched');
  assert.equal((await rows()).filter((x) => x.status === 'closed' && x.lot_code === 'R4').length, 0);
});

test('an operation that starts while ERPNext is being read: its lots are left alone, closed findings included', async () => {
  // R2 is back in stores in ERPNext, so its "place" finding would close tonight.
  await h.stockEntry(client, 'Material Transfer', [h.row({ item_code: N.ROUGH, qty: 40, s_warehouse: N.WORK, t_warehouse: N.STORES, batch_no: 'R2-TC' })]);
  const place = (await reconcile.open(user)).find((m) => m.kind === 'place' && m.lot === 'R2');
  assert.ok(place);

  let begun = null;
  const starting = Object.create(client);
  starting.listResource = async (doctype, ...rest) => {
    const out = await client.listResource(doctype, ...rest);
    // the list of batches is read after the lots: the operation starts in between
    if (doctype === 'Batch' && !begun) begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'write_off', reason: 'lost', inputs: [h.input(await lot('R2'))] }) });
    return out;
  };
  const r = await reconcile.run(user, starting);
  assert.ok(begun);
  assert.ok(r.unchecked.includes('R2'));
  assert.equal(r.closed, 0);
  assert.ok((await reconcile.open(user)).some((m) => m.id === place.id), 'the place finding stays open');
  assert.ok((await reconcile.open(user)).some((m) => m.kind === 'no_lot'), 'and so do the extras: the operation may be moving stones');

  // One that is open from the start: the same.
  const again = await reconcile.run(user, client);
  assert.ok(again.unchecked.includes('R2'));
  assert.equal(again.closed, 0);
  await store.failOp(begun.id, 'dropped by the test');

  // Once it is over, and R2 can be read, the finding is closed by a run that checked it.
  const afterFail = await reconcile.run(user, failing('listResource', (doctype, opts) => doctype === 'Stock Ledger Entry' && JSON.stringify(opts.filters).includes('R2-TC')));
  assert.equal(afterFail.closed, 0);
  assert.ok((await reconcile.open(user)).some((m) => m.id === place.id));
  const done = await reconcile.run(user, client);
  assert.equal(done.closed, 1);
  assert.equal((await reconcile.open(user)).some((m) => m.id === place.id), false);
  assert.equal(done.unchecked, undefined);
});

test('a difference of a satang is rounding; two are a finding', async () => {
  for (const [code, cost] of [['V1', 100.01], ['V2', 100.02]]) {
    await client.createResource('Batch', { batch_id: `${code}-TC`, item: N.ROUGH });
    await h.stockEntry(client, 'Material Receipt', [h.row({ item_code: N.ROUGH, qty: 5, t_warehouse: N.STORES, batch_no: `${code}-TC`, basic_amount: 100, expense_account: N.EQUITY })]);
    await h.recordPosted(user, h.resolvedOp({ kind: 'buy', counterparty: N.SUPPLIER, outputs: [h.output({ code, carats: 5, cost })] }));
  }
  const r = await reconcile.run(user, client);
  assert.deepEqual(brief(r.mismatches.filter((m) => /^V/.test(m.lot || ''))), [['value', 'V2', 100.02, 100]]);
});
