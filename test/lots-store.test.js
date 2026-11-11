/**
 * The lot store (src/lots/store.js): how an operation is recorded, applied to the lot rows and
 * taken back. ERPNext is the fake; the operations here are recorded with the test helpers, not
 * posted by execute.js. Tests share state and run in order.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const db = require('../src/db');
const store = require('../src/lots/store');

const erp = new FakeErpNext();
let user;
let other;
let client;

const lot = (code, u = user) => store.getLot(u.id, code);
const facts = (l) => l && [l.status, l.carats, l.pieces, l.cost, l.location, l.holder];
/** An undo as undo.run does it: begin, cancel every document, put the lots back. */
async function undo(opId) {
  await store.markUndoing(opId);
  for (const d of (await store.getOpById(opId)).erpnext_docs) await store.markDocCancelled(opId, d.name);
  return store.reverseOp(opId);
}

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
  other = await h.addUser();
});

test('a seeded lot exists in Berpal and in ERPNext, and only for its owner', async () => {
  const l12 = await h.seedLot(user, client, { code: 'L12', carats: 200, cost: 300000, attrs: { species: 'ruby', origin: 'Mogok' } });
  assert.deepEqual(facts(l12), ['active', 200, null, 300000, 'stores', null]);
  assert.deepEqual([l12.erpnext_item, l12.erpnext_batch, l12.revision, l12.form, l12.species], [h.N.ROUGH, 'L12-TC', 0, 'rough', 'ruby']);
  assert.equal(await h.batchQty(client, 'L12-TC', h.N.STORES), 200);
  assert.equal(l12.seed.op.status, 'posted');
  assert.deepEqual(l12.seed.op.erpnext_docs, [{ step: 1, doctype: 'Stock Entry', name: l12.seed.entry }]);
  assert.equal(await lot('L12', other), null);
  assert.deepEqual(await store.nextCodes(user.id, 2), ['L13', 'L14']);
  assert.deepEqual(await store.nextCodes(user.id, 2, { taken: ['L13'] }), ['L14', 'L15']);
  assert.deepEqual(await store.nextCodes(other.id, 1), ['L1']);
});

test('one unfinished operation blocks the next; a failed one does not', async () => {
  const l12 = await lot('L12');
  const op = h.resolvedOp({ kind: 'write_off', reason: 'lost', inputs: [h.input(l12, { carats: 1 })] });
  const begun = await store.beginOp(user, { op, draft: { stock_op: { kind: 'write_off' }, confirmation_pending: 'x', trust_warnings: ['w'] } });
  assert.equal(begun.status, 'pending');
  assert.match(begun.reference, /^BPL-/);
  assert.deepEqual(begun.plan.draft, { stock_op: { kind: 'write_off' }, trust_warnings: ['w'] });
  await assert.rejects(store.beginOp(user, { op }), new RegExp(`Stock operation ${begun.reference} is not finished yet`));
  assert.equal((await store.unfinishedOps(user.id)).length, 1);
  assert.equal((await store.unfinishedOps(other.id)).length, 0);
  await store.failOp(begun.id, 'ERPNext refused');
  assert.equal((await store.getOpById(begun.id)).status, 'failed');
  assert.equal((await store.unfinishedOps(user.id)).length, 0);
  assert.deepEqual(facts(await lot('L12')), ['active', 200, null, 300000, 'stores', null]);
});

test('a recorded document makes the operation partial, and failOp then refuses', async () => {
  const l12 = await lot('L12');
  const begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'write_off', inputs: [h.input(l12, { carats: 1 })] }) });
  const step = await store.recordStep(begun.id, { step: 1, doctype: 'Stock Entry', name: 'STE-X' });
  assert.deepEqual([step.status, step.steps_done], ['partial', 1]);
  await store.recordStep(begun.id, { step: 1, doctype: 'Stock Entry', name: 'STE-X' });
  assert.equal((await store.getOpById(begun.id)).erpnext_docs.length, 1);
  await assert.rejects(store.failOp(begun.id, 'no'));
  // The way out of a stuck operation: its document is cancelled, then it is reversed.
  await assert.rejects(store.reverseOp(begun.id), /is only partly in the books; it has to be marked as being undone/);
  await assert.rejects(store.markDocCancelled(begun.id, 'STE-X'), /its documents are only cancelled while it is being undone/);
  await store.markUndoing(begun.id);
  await assert.rejects(store.markDocCancelled(begun.id, 'STE-NOPE'), /has no document called STE-NOPE/);
  await assert.rejects(store.reverseOp(begun.id), /still has documents in the books \(STE-X\); they have to be cancelled/);
  await store.markDocCancelled(begun.id, 'STE-X');
  assert.deepEqual(await store.reverseOp(begun.id), []);
  assert.equal((await store.getOpById(begun.id)).status, 'undone');
  assert.deepEqual(await store.reverseOp(begun.id), [], 'undoing what is undone again changes nothing');
  await assert.rejects(store.recordStep(begun.id, { step: 2, doctype: 'Stock Entry', name: 'STE-Y' }), /is undone, so nothing more can be added/);
  await store.recordStep(begun.id, { step: 1, doctype: 'Stock Entry', name: 'STE-X' }); // a step already on record is not an error
  assert.equal((await store.unfinishedOps(user.id)).length, 0);
});

test('a document recorded on an operation that was dropped as failed opens it again', async () => {
  const l12 = await lot('L12');
  const begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'write_off', inputs: [h.input(l12, { carats: 1 })] }) });
  // The nightly check found nothing and dropped it, while a retry's document was on its way to the books.
  const [failed, step] = await Promise.all([
    store.failOp(begun.id, 'nothing found'),
    store.recordStep(begun.id, { step: 1, doctype: 'Stock Entry', name: 'STE-LATE' }),
  ]);
  assert.equal(failed.status, 'failed');
  assert.deepEqual([step.status, step.erpnext_docs.map((d) => d.name)], ['partial', ['STE-LATE']]);
  assert.equal((await store.unfinishedOps(user.id)).length, 1, 'it is open again, so a retry or an undo can finish it');
  await assert.rejects(store.failOp(begun.id, 'again'), /already in the books/);
  await store.markUndoing(begun.id);
  await store.markDocCancelled(begun.id, 'STE-LATE');
  await store.reverseOp(begun.id);
});

test('split: the source closes, the parts carry its cost, lineage links them', async () => {
  const l12 = await lot('L12');
  const op = h.resolvedOp({
    kind: 'split', inputs: [h.input(l12)],
    outputs: [h.output({ code: 'L13', carats: 120, cost: 270000, line: 0 }), h.output({ code: 'L14', carats: 80, cost: 30000, line: 1 })],
  });
  const done = await h.recordPosted(user, op, { docs: [{ doctype: 'Stock Entry', name: 'STE-SPLIT' }] });
  assert.deepEqual(done.lots.map((l) => [l.code, l.carats, l.cost, l.status]),
    [['L13', 120, 270000, 'active'], ['L14', 80, 30000, 'active'], ['L12', 0, 0, 'closed']]);
  assert.deepEqual(facts(await lot('L12')), ['closed', 0, null, 0, 'stores', null]);
  assert.deepEqual([(await lot('L13')).erpnext_batch, (await lot('L13')).erpnext_item], ['L13-TC', h.N.ROUGH]);
  const tree = await store.lineage(user.id, 'L13');
  assert.deepEqual(tree.ancestors.map((a) => a.code), ['L12']);
  assert.deepEqual((await store.lineage(user.id, 'L12')).descendants.map((d) => d.code).sort(), ['L13', 'L14']);
  const hist = await store.history(user.id, 'L12');
  assert.deepEqual(hist.map((x) => x.kind), ['split', 'buy']);
  assert.deepEqual((await store.listLots(user.id)).map((l) => l.code).sort(), ['L13', 'L14']);
  // posting twice changes nothing
  assert.deepEqual((await store.postOp(done.op.id)).map((l) => l.code), ['L13', 'L14', 'L12']);
  assert.equal((await lot('L13')).carats, 120);
});

test('a whole lot out for work and back: one custody row, opened and closed', async () => {
  const l13 = await lot('L13');
  const out = await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_work', holder: h.N.CUTTER, due_date: '2030-01-31',
    inputs: [h.input(l13)], outputs: [h.output({ lot: l13, carats: 120, cost: 270000, to: 'work' })],
  }), { docs: [{ doctype: 'Stock Entry', name: 'STE-OUT' }] });
  assert.deepEqual(facts(await lot('L13')), ['active', 120, null, 270000, 'work', h.N.CUTTER]);
  let custody = await store.listCustody(user.id);
  assert.deepEqual(custody.map((c) => [c.lot_code, c.holder, c.purpose, c.carats_out, c.due_date, c.status]),
    [['L13', h.N.CUTTER, 'work', 120, '2030-01-31', 'out']]);

  const back = await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'return', holder: h.N.CUTTER,
    inputs: [h.input(await lot('L13'))], outputs: [h.output({ lot: await lot('L13'), carats: 120, cost: 270000, to: 'stores' })],
  }), { docs: [{ doctype: 'Stock Entry', name: 'STE-BACK' }] });
  assert.deepEqual(facts(await lot('L13')), ['active', 120, null, 270000, 'stores', null]);
  assert.equal((await store.listCustody(user.id)).length, 0);
  custody = await store.listCustody(user.id, { status: 'all' });
  assert.deepEqual(custody.map((c) => [c.status, c.carats_returned]), [['returned', 120]]);

  // The first move cannot be undone while the return stands; the return can.
  const outDocs = JSON.stringify(out.op.erpnext_docs);
  await store.markUndoing(out.op.id);
  await store.markDocCancelled(out.op.id, 'STE-OUT');
  await assert.rejects(store.reverseOp(out.op.id), /Lot L13 was used again after this \(move .* Undo that first\./);
  // (undo.resolve never starts this; put the operation back as it was so the return can be undone first.)
  await db.query("UPDATE lot_ops SET status = 'posted', erpnext_docs = $1 WHERE id = $2", [outDocs, out.op.id]);
  await undo(back.op.id);
  assert.deepEqual(facts(await lot('L13')), ['active', 120, null, 270000, 'work', h.N.CUTTER]);
  assert.deepEqual((await store.listCustody(user.id)).map((c) => [c.status, c.carats_returned]), [['out', 0]]);
  await undo(out.op.id);
  assert.deepEqual(facts(await lot('L13')), ['active', 120, null, 270000, 'stores', null]);
  assert.equal((await store.listCustody(user.id, { status: 'all' })).length, 0);
});

test('cutting makes a new counted lot; undo deletes it and gives the rough back', async () => {
  const l13 = await lot('L13');
  const op = h.resolvedOp({
    kind: 'transform', job: 'cutting', holder: h.N.CUTTER, yield_pct: 25, loss_carats: 90,
    fee: { amount: 2400, capitalised: 2400, basis: 'per_ct' },
    inputs: [h.input(l13)], outputs: [h.output({ code: 'L15', carats: 30, pieces: 42, cost: 272400, form: 'cut' })],
  });
  const done = await h.recordPosted(user, op, { docs: [{ doctype: 'Journal Entry', name: 'JV-FEE' }, { doctype: 'Stock Entry', name: 'STE-CUT' }] });
  assert.deepEqual([done.op.yield_pct, done.op.fee_amount, done.op.fee_basis], [25, 2400, 'per_ct']);
  const l15 = await lot('L15');
  assert.deepEqual(facts(l15), ['active', 30, 42, 272400, 'stores', null]);
  assert.deepEqual([l15.erpnext_item, l15.form], [h.N.CUT, 'cut']);
  assert.equal(await store.countOps(user.id, { kinds: ['split', 'transform'] }), 2);

  assert.deepEqual((await undo(done.op.id)).map((l) => [l.code, l.carats, l.cost, l.status]), [['L13', 120, 270000, 'active']]);
  assert.equal(await lot('L15'), null);
  assert.equal(await store.countOps(user.id, { kinds: ['split', 'transform'] }), 1);
  assert.deepEqual(await store.nextCodes(user.id, 1), ['L15']);

  await h.recordPosted(user, op, { docs: [{ doctype: 'Stock Entry', name: 'STE-CUT2' }] });
  assert.deepEqual(facts(await lot('L15')), ['active', 30, 42, 272400, 'stores', null]);
});

test('part of a lot sold from memo: carats, pieces and custody follow', async () => {
  const l15 = await lot('L15');
  await h.recordPosted(user, h.resolvedOp({
    kind: 'split', inputs: [h.input(l15)],
    outputs: [h.output({ code: 'L16', carats: 8, pieces: 10, cost: 175741.94, form: 'cut' }), h.output({ code: 'L17', carats: 22, pieces: 32, cost: 96658.06, form: 'cut' })],
  }));
  const l16 = await lot('L16');
  await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_memo', holder: 'Broker Lek', memo_price_per_ct: 30000,
    inputs: [h.input(l16)], outputs: [h.output({ lot: l16, carats: 8, pieces: 10, cost: 175741.94, to: 'memo', form: 'cut' })],
  }));
  assert.deepEqual(facts(await lot('L16')), ['active', 8, 10, 175741.94, 'memo', 'Broker Lek']);
  const sale = await h.recordPosted(user, h.resolvedOp({
    kind: 'sell', counterparty: h.N.CUSTOMER, inputs: [h.input(await lot('L16'), { carats: 5.5, pieces: 7, cost: 120822.58 })],
  }), { docs: [{ doctype: 'Sales Invoice', name: 'SINV-1' }] });
  assert.deepEqual(facts(await lot('L16')), ['active', 2.5, 3, 54919.36, 'memo', 'Broker Lek']);
  assert.deepEqual((await store.listCustody(user.id)).map((c) => [c.lot_code, c.purpose, c.carats_out, c.carats_sold, c.memo_price_per_ct, c.currency]),
    [['L16', 'memo', 8, 5.5, 30000, 'THB']]);
  await undo(sale.op.id);
  assert.deepEqual(facts(await lot('L16')), ['active', 8, 10, 175741.94, 'memo', 'Broker Lek']);
  assert.equal((await store.listCustody(user.id))[0].carats_sold, 0);
});

test('a recut keeps the code, takes a new batch and outdates the lab report', async () => {
  const l17 = await lot('L17');
  await store.addCertificate(user.id, 'L17', { lab: 'GRS', report_no: 'GRS2030-1', stated_carats: 22 });
  const done = await h.recordPosted(user, h.resolvedOp({
    kind: 'transform', job: 'recut', yield_pct: 90.9, loss_carats: 2,
    inputs: [h.input(l17)], outputs: [h.output({ lot: l17, carats: 20, pieces: 32, cost: 96658.06, form: 'cut', revision: 1 })],
  }));
  let now = await lot('L17');
  assert.deepEqual([now.carats, now.pieces, now.cost, now.revision, now.erpnext_batch], [20, 32, 96658.06, 1, 'L17-r1-TC']);
  assert.deepEqual((await store.listCertificates(now.id)).map((c) => c.outdated), [true]);
  await undo(done.op.id);
  now = await lot('L17');
  assert.deepEqual([now.carats, now.pieces, now.cost, now.revision, now.erpnext_batch], [22, 32, 96658.06, 0, 'L17-TC']);
  assert.deepEqual((await store.listCertificates(now.id)).map((c) => c.outdated), [false]);
});

test('details are whitelisted; searches see only the owner', async () => {
  const set = await store.setDetails(user.id, 'L14', { colour: 'pinkish red', ask_per_ct: 900, carats: 999, cost: 1 });
  assert.deepEqual([set.colour, set.ask_per_ct, set.carats, set.cost], ['pinkish red', 900, 80, 30000]);
  assert.equal(await store.setDetails(other.id, 'L14', { colour: 'x' }), null);
  assert.deepEqual((await store.listLots(user.id, { search: 'pinkish' })).map((l) => l.code), ['L14']);
  assert.deepEqual((await store.listLots(user.id, { location: 'memo' })).map((l) => l.code), ['L16']);
  assert.deepEqual(await store.listLots(other.id, { status: 'all' }), []);
});

test('an undo that cancelled nothing puts a fully posted operation back to posted, and only that', async () => {
  const l60 = await h.seedLot(user, client, { code: 'L60', carats: 20, cost: 2000 });
  const split = h.resolvedOp({
    kind: 'split', inputs: [h.input(l60)],
    outputs: [h.output({ code: 'L61', carats: 12, cost: 1500 }), h.output({ code: 'L62', carats: 8, cost: 500 })],
  });
  const done = await h.recordPosted(user, split, { docs: [{ doctype: 'Stock Entry', name: 'STE-U1' }] });
  const state = async () => [facts(await lot('L60')), facts(await lot('L61')), facts(await lot('L62'))];
  const posted = await state();
  assert.deepEqual(posted, [['closed', 0, null, 0, 'stores', null], ['active', 12, null, 1500, 'stores', null], ['active', 8, null, 500, 'stores', null]]);
  assert.equal(await store.unmarkUndoing(done.op.id), null, 'a posted operation is not being undone: nothing to do');
  assert.equal(await store.unmarkUndoing(999999), null);

  // The undo begins, ERPNext refuses the first cancel: nothing was cancelled, so it is simply still posted.
  await store.markUndoing(done.op.id);
  await store.noteError(done.op.id, 'ERPNext refused the cancel');
  assert.equal((await store.unfinishedOps(user.id)).length, 1);
  assert.equal(await store.unmarkUndoing(done.op.id), 'posted');
  const back = await store.getOpById(done.op.id);
  assert.deepEqual([back.status, back.error, back.erpnext_docs, back.posted_at], ['posted', null, done.op.erpnext_docs, done.op.posted_at]);
  assert.equal((await store.unfinishedOps(user.id)).length, 0);
  assert.deepEqual(await state(), posted, 'the lots are untouched');

  // Once a document is cancelled there is no way back but forward.
  await store.markUndoing(done.op.id);
  await store.markDocCancelled(done.op.id, 'STE-U1');
  assert.equal(await store.unmarkUndoing(done.op.id), null, 'a document is cancelled: there is no way back');
  assert.equal((await store.getOpById(done.op.id)).status, 'undoing');
  assert.deepEqual(await state(), posted);
  await store.reverseOp(done.op.id);
  assert.deepEqual(facts(await lot('L60')), ['active', 20, null, 2000, 'stores', null]);
  assert.equal(await store.unmarkUndoing(done.op.id), null, 'an undone operation stays undone');

  // An operation that was only partly posted (or not at all) when its undo began was never posted: it goes back to partial, not posted.
  for (const steps of [1, 0]) {
    const begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'write_off', reason: 'lost', inputs: [h.input(await lot('L60'), { carats: 1 })] }) });
    if (steps) await store.recordStep(begun.id, { step: 1, doctype: 'Stock Entry', name: 'STE-U2' });
    await store.markUndoing(begun.id);
    assert.equal(await store.unmarkUndoing(begun.id), 'partial');
    assert.equal((await store.getOpById(begun.id)).status, 'partial');
    assert.deepEqual(facts(await lot('L60')), ['active', 20, null, 2000, 'stores', null]);
    await undo(begun.id);
  }
  assert.equal((await store.unfinishedOps(user.id)).length, 0);
});

// ── hardening ────────────────────────────────────────────────────────

/** beginOp + recordStep + (the part of recordPosted before postOp): an operation that only needs postOp. */
async function ready(op, docs = [{ doctype: 'Stock Entry', name: `STE-${Math.random().toString(36).slice(2, 8)}` }]) {
  const begun = await store.beginOp(user, { op });
  for (const [i, d] of docs.entries()) await store.recordStep(begun.id, { step: i + 1, doctype: d.doctype, name: d.name });
  const outputs = {};
  for (const out of op.outputs) outputs[out.code] = out.new ? { item: h.ITEM[out.item_kind], batch: h.batchOf(out.code, out.revision) } : {};
  return { id: begun.id, actuals: { outputs } };
}
const lineCount = async (opId) => (await store.opLines(opId)).length;
const snapshot = async (...codes) => Promise.all(codes.map(async (c) => facts(await lot(c))));

test('two callers finishing the same operation at once: one set of lines, the lots change once', async () => {
  const d1 = await h.seedLot(user, client, { code: 'D1', carats: 10, cost: 1000, attrs: { colour: 'red' } });
  const op = h.resolvedOp({
    kind: 'split', inputs: [h.input(d1)],
    outputs: [h.output({ code: 'D2', carats: 6, cost: 600 }), h.output({ code: 'D3', carats: 4, cost: 400 })],
  });
  const { id, actuals } = await ready(op);
  const results = await Promise.all([store.postOp(id, { actuals }), store.postOp(id, { actuals }), store.postOp(id, { actuals })]);
  assert.equal(await lineCount(id), 3, 'one input line and two output lines, not three times that');
  for (const r of results) assert.deepEqual(r.map((l) => l.code), ['D2', 'D3', 'D1']);
  assert.deepEqual(await snapshot('D1', 'D2', 'D3'), [['closed', 0, null, 0, 'stores', null], ['active', 6, null, 600, 'stores', null], ['active', 4, null, 400, 'stores', null]]);
  assert.equal((await store.getOpById(id)).status, 'posted');

  // The undo that follows takes the carats and cost back exactly once.
  await undo(id);
  assert.deepEqual(await snapshot('D1', 'D2', 'D3'), [['active', 10, null, 1000, 'stores', null], null, null]);
  assert.equal(await lineCount(id), 0);
  // Posting what is undone is refused; asking again for what is posted changes nothing.
  await assert.rejects(store.postOp(id, { actuals }), /is undone; it cannot be finished/);
  await assert.rejects(store.postOp(999999), /not on record/);
});

test('two operations begun at the same moment: only one is let in, and the database says the same', async () => {
  const op = h.resolvedOp({ kind: 'write_off', reason: 'lost', inputs: [h.input(await lot('D1'), { carats: 1 })] });
  const settled = await Promise.allSettled([store.beginOp(user, { op }), store.beginOp(user, { op }), store.beginOp(user, { op })]);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of settled.filter((x) => x.status === 'rejected')) assert.match(r.reason.message, /^Stock operation BPL-\w+ is not finished yet$/);
  const open = await store.unfinishedOps(user.id);
  assert.equal(open.length, 1);

  // Another user is not held up by it, even at the same moment.
  const both = await Promise.allSettled([store.beginOp(other, { op: h.resolvedOp({ kind: 'write_off', inputs: [] }) }), store.beginOp(user, { op })]);
  assert.deepEqual(both.map((r) => r.status), ['fulfilled', 'rejected']);
  await store.failOp((await store.unfinishedOps(other.id))[0].id, 'test');

  // The unique index refuses a second open operation even when the check is bypassed.
  const raw = (status) => db.query(
    `INSERT INTO lot_ops (user_id, kind, status, reference, op_date, plan, created_at) VALUES ($1, 'write_off', $2, $3, '2030-01-01', '{}', 'x')`,
    [user.id, status, `RAW-${status}-${Math.random()}`]
  );
  await assert.rejects(raw('pending'), /duplicate key|unique/i);
  await assert.rejects(raw('undoing'), /duplicate key|unique/i);
  await raw('posted');
  await raw('failed');

  // A finished operation cannot start being undone while another is open.
  const posted = await store.getOpById((await db.query("SELECT id FROM lot_ops WHERE user_id = $1 AND status = 'posted' ORDER BY id DESC LIMIT 1", [user.id])).rows[0].id);
  await assert.rejects(store.markUndoing(posted.id), new RegExp(`Stock operation ${open[0].reference} is not finished yet\\. Finish it or undo it first`));
  assert.equal((await store.getOpById(posted.id)).status, 'posted');
  await store.failOp(open[0].id, 'test');
  await assert.rejects(store.beginOp(user, { op: { kind: 'nonsense' } }), /not something that can be done to stones/);
  await db.query("DELETE FROM lot_ops WHERE reference LIKE 'RAW-%'");
});

test('undoing shows what it throws away: certificates on lots it made, details edited since', async () => {
  const d1 = await lot('D1');
  const split = await h.recordPosted(user, h.resolvedOp({
    kind: 'split', inputs: [h.input(d1)],
    outputs: [h.output({ code: 'D2', carats: 6, cost: 600, attrs: { colour: 'red' } }), h.output({ code: 'D3', carats: 4, cost: 400, attrs: { colour: 'red' } })],
  }), { docs: [{ doctype: 'Stock Entry', name: 'STE-D-SPLIT' }] });
  assert.deepEqual(await store.reverseLosses(split.op.id), { certificates: [], detailsChanged: [] });
  await store.addCertificate(user.id, 'D2', { lab: 'GRS', report_no: 'GRS-77' });
  await store.addCertificate(user.id, 'D3', { lab: 'SSEF' });
  assert.deepEqual(await store.reverseLosses(split.op.id), {
    certificates: [{ lot: 'D2', lab: 'GRS', report_no: 'GRS-77' }, { lot: 'D3', lab: 'SSEF', report_no: null }],
    detailsChanged: [],
  });
  const gone = await undo(split.op.id);
  assert.deepEqual([...gone.certificates], [{ lot: 'D2', lab: 'GRS', report_no: 'GRS-77' }, { lot: 'D3', lab: 'SSEF', report_no: null }]);
  assert.deepEqual([...gone.detailsChanged], []);
  assert.deepEqual(gone.map((l) => l.code), ['D1'], 'the list itself is still the lots that are back');
  assert.equal(await lot('D2'), null);
  assert.deepEqual(await store.reverseLosses(split.op.id), { certificates: [], detailsChanged: [] }, 'nothing left to lose once it is undone');

  // A lot the operation only re-used: edits made after it go back to what it was before it.
  const out = await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_work', holder: h.N.CUTTER, inputs: [h.input(await lot('D1'))],
    outputs: [h.output({ lot: await lot('D1'), carats: 10, cost: 1000, to: 'work' })],
  }), { docs: [{ doctype: 'Stock Entry', name: 'STE-D-OUT' }] });
  assert.deepEqual(await store.reverseLosses(out.op.id), { certificates: [], detailsChanged: [] });
  await store.setDetails(user.id, 'D1', { colour: 'pigeon blood', ask_per_ct: 5 });
  assert.deepEqual(await store.reverseLosses(out.op.id), { certificates: [], detailsChanged: ['D1'] });
  const back = await undo(out.op.id);
  assert.deepEqual([...back.detailsChanged], ['D1']);
  assert.equal((await lot('D1')).colour, 'red');

  // What the operation wrote itself is not a loss, and a certificate on a re-used lot is kept (only flagged).
  await store.addCertificate(user.id, 'D1', { lab: 'GIA', report_no: 'G-1' });
  const recut = await h.recordPosted(user, h.resolvedOp({
    kind: 'transform', job: 'recut', inputs: [h.input(await lot('D1'))],
    outputs: [h.output({ lot: await lot('D1'), carats: 9, cost: 1000, revision: 1, attrs: { treatment: 'H' } })],
  }));
  assert.deepEqual(await store.reverseLosses(recut.op.id), { certificates: [], detailsChanged: [] });
  const again = await undo(recut.op.id);
  assert.deepEqual([[...again.certificates], [...again.detailsChanged]], [[], []]);
  assert.deepEqual((await store.listCertificates((await lot('D1')).id)).map((c) => [c.lab, c.outdated]), [['GIA', false]]);
});

test('part of a lot that is out with someone, written off: the custody row follows, and undo restores it', async () => {
  const c1 = await h.seedLot(user, client, { code: 'C1', carats: 20, cost: 2000, pieces: 10, location: 'work', holder: h.N.CUTTER });
  const row = async () => (await store.listCustody(user.id, { lot: 'C1', status: 'all' })).map((c) => [c.status, c.carats_out, c.pieces_out, c.carats_returned, c.carats_sold]);
  assert.deepEqual(await row(), [['out', 20, 10, 0, 0]]);
  const part = await h.recordPosted(user, h.resolvedOp({
    kind: 'write_off', reason: 'broken', inputs: [h.input(c1, { carats: 5, pieces: 2 })],
  }), { docs: [{ doctype: 'Stock Entry', name: 'STE-C1-W' }] });
  assert.deepEqual(facts(await lot('C1')), ['active', 15, 8, 1500, 'work', h.N.CUTTER]);
  assert.deepEqual(await row(), [['out', 15, 8, 0, 0]], 'only what is still out counts as out');
  await undo(part.op.id);
  assert.deepEqual(facts(await lot('C1')), ['active', 20, 10, 2000, 'work', h.N.CUTTER]);
  assert.deepEqual(await row(), [['out', 20, 10, 0, 0]]);
  // All of it: the row closes as lost with what went out.
  const all = await h.recordPosted(user, h.resolvedOp({ kind: 'write_off', reason: 'stolen', inputs: [h.input(await lot('C1'))] }));
  assert.deepEqual(await row(), [['lost', 20, 10, 0, 0]]);
  await undo(all.op.id);
  assert.deepEqual(await row(), [['out', 20, 10, 0, 0]]);
});

test('a cost the books took out that is far above the lot is refused, not clamped; rounding is absorbed', async () => {
  const c2 = await h.seedLot(user, client, { code: 'C2', carats: 10, cost: 100 });
  const c3 = await h.seedLot(user, client, { code: 'C3', carats: 10, cost: 100 });
  const off = (lotRow, cost) => h.resolvedOp({ kind: 'write_off', reason: 'lost', inputs: [h.input(lotRow, { carats: 5, cost })] });
  await assert.rejects(h.recordPosted(user, off(c2, 150)), /value the stones taken from lot C2 at 150, but the lot only carries 100\. The two have drifted apart/);
  assert.deepEqual(await snapshot('C2'), [['active', 10, null, 100, 'stores', null]]);
  await store.failOp((await store.unfinishedOps(user.id))[0].id, 'test');
  await h.recordPosted(user, off(c3, 100.01));
  assert.deepEqual(await snapshot('C3'), [['active', 5, null, 0, 'stores', null]]);
});

test('lot searches treat % _ and \\ as plain characters; lotTotals counts what listLots would show without its limit', async () => {
  const seed = (code, attrs, extra = {}) => h.seedLot(user, client, { code, carats: 2, cost: 10, attrs, ...extra });
  await seed('W1', { description: '100% natural' });
  await seed('W2', { description: '100 percent natural' });
  await seed('W3', { description: 'a_b stone' });
  await seed('W4', { description: 'axb stone' });
  await seed('W5', { description: 'back\\slash' });
  await seed('W6', { description: 'plain' }, { location: 'work', holder: 'Somchai_B' });
  await seed('W7', { description: 'plain' }, { location: 'work', holder: 'Somchai B' });
  const codes = async (f) => (await store.listLots(user.id, f)).map((l) => l.code).sort();
  assert.deepEqual(await codes({ search: '%' }), ['W1']);
  assert.deepEqual(await codes({ search: '100%' }), ['W1']);
  assert.deepEqual(await codes({ search: '_' }), ['W3'], 'an underscore is not "any character"');
  assert.deepEqual(await codes({ search: 'a_b' }), ['W3']);
  assert.deepEqual(await codes({ search: '\\' }), ['W5']);
  assert.deepEqual(await codes({ search: 'NATURAL' }), ['W1', 'W2'], 'case does not matter');
  assert.deepEqual(await codes({ holder: '_B' }), ['W6']);
  assert.deepEqual((await codes({ holder: 'somchai', location: 'work' })).filter((c) => c.startsWith('W')), ['W6', 'W7']);
  assert.deepEqual((await store.listCustody(user.id, { holder: '_b' })).map((c) => c.lot_code), ['W6']);
  assert.deepEqual(await store.lotTotals(user.id, { search: '%' }), { count: 1, carats: 2, cost: 10 });
  assert.deepEqual(await store.lotTotals(user.id, { search: 'natural' }), { count: 2, carats: 4, cost: 20 });
  assert.deepEqual(await store.lotTotals(user.id, { search: 'no such stone' }), { count: 0, carats: 0, cost: 0 });
  assert.deepEqual(await store.lotTotals(other.id, { status: 'all' }), { count: 0, carats: 0, cost: 0 });

  // No limit: the totals cover every lot that fits, the list stops at its limit.
  const active = await store.listLots(user.id, { limit: 500 });
  const totals = await store.lotTotals(user.id, { limit: 1 });
  assert.equal(totals.count, active.length);
  assert.equal((await store.listLots(user.id, { limit: 1 })).length, 1);
  assert.deepEqual([totals.carats, totals.cost], [Math.round(active.reduce((t, l) => t + l.carats, 0) * 1000) / 1000, Math.round(active.reduce((t, l) => t + l.cost, 0) * 100) / 100]);
  assert.equal((await store.lotTotals(user.id, { status: 'closed' })).count, (await store.listLots(user.id, { status: 'closed', limit: 500 })).length);
  assert.equal(typeof totals.carats, 'number');
});

test('new codes continue the numbering; a code that is really a date or a bill number does not drag it along', async () => {
  const [next] = await store.nextCodes(user.id, 1);
  const n = Number(next.slice(1));
  assert.deepEqual(await store.nextCodes(user.id, 2, { taken: [next] }), [`L${n + 1}`, `L${n + 2}`]);
  assert.deepEqual(await store.nextCodes(user.id, 0), []);
  await h.seedLot(user, client, { code: 'L20260110', carats: 1, cost: 1 });
  assert.deepEqual(await store.nextCodes(user.id, 1), [next], 'a six-digit L-code is not part of the numbering');
  assert.deepEqual(await store.nextCodes(user.id, 1, { taken: ['L99999'] }), ['L100000'], 'but five digits still are');
});
