/**
 * Taking a lot operation back (src/lots/undo.js): which operation an undo means, what it refuses,
 * the card, and the run against the fake ERPNext (documents cancelled newest first, the lot rows
 * put back). The safety rules: a document ERPNext holds but the record missed is found and
 * cancelled too; a money document that cannot be cancelled refuses the whole undo before anything
 * moves; an unknown outcome of a cancel leaves the operation 'undoing'. And one undo end to end
 * through the confirmation gate.
 *
 * State is made the way lots-helpers documents: real Stock Entries in the fake, the operation
 * recorded through the store. Each test works on lots of its own.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const db = require('../src/db');
const lots = require('../src/lots');
const store = require('../src/lots/store');
const undo = require('../src/lots/undo');
const gate = require('../src/lots/gate');

const { N, TODAY } = h;
const erp = new FakeErpNext();
let user; let client;

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
});

const lot = (code) => store.getLot(user.id, code);
const facts = (l) => l && [l.status, l.carats, l.pieces, l.cost, l.location, l.holder];
const status = async (reference) => (await store.getOp(user.id, reference)).status;
const docstatus = (doctype, name) => erp.get(doctype, name).docstatus;
const batch = (code, item = N.ROUGH) => client.createResource('Batch', { batch_id: h.batchOf(code), item });
const ste = (name) => ({ doctype: 'Stock Entry', name });

/** A seeded lot split in two, in the fake and in Berpal. */
async function split(code, a, b) {
  const src = await h.seedLot(user, client, { code, carats: 200, cost: 300000 });
  await batch(a); await batch(b);
  const entry = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 200, s_warehouse: N.STORES, batch_no: h.batchOf(code) }),
    h.valued({ item_code: N.ROUGH, qty: 120, t_warehouse: N.STORES, batch_no: h.batchOf(a), basic_amount: 270000 }),
    h.valued({ item_code: N.ROUGH, qty: 80, t_warehouse: N.STORES, batch_no: h.batchOf(b), basic_amount: 30000 }),
  ]);
  const done = await h.recordPosted(user, h.resolvedOp({
    kind: 'split', inputs: [h.input(src)],
    outputs: [h.output({ code: a, carats: 120, cost: 270000 }), h.output({ code: b, carats: 80, cost: 30000 })],
  }), { docs: [ste(entry.name)] });
  return { reference: done.op.reference, entry: entry.name };
}

/** A seeded rough lot cut into a cut lot, the fee (2,400) capitalised through `fee` = an ERPNext document. */
async function cut(code, into, fee) {
  const src = await h.seedLot(user, client, { code, carats: 120, cost: 270000 });
  await batch(into, N.CUT);
  const entry = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 120, s_warehouse: N.STORES, batch_no: h.batchOf(code) }),
    h.valued({ item_code: N.CUT, qty: 30, t_warehouse: N.STORES, batch_no: h.batchOf(into), basic_amount: 270000 }),
  ], { additional_costs: [{ expense_account: N.VALUATION, description: 'Cutting fee', amount: 2400 }] });
  const done = await h.recordPosted(user, h.resolvedOp({
    kind: 'transform', job: 'cutting', holder: N.CUTTER, yield_pct: 25, loss_carats: 90,
    fee: { amount: 2400, capitalised: 2400, basis: 'fixed' },
    inputs: [h.input(src)], outputs: [h.output({ code: into, carats: 30, pieces: 42, cost: 272400, form: 'cut' })],
  }), { docs: [fee, ste(entry.name)] });
  return { reference: done.op.reference, entry: entry.name };
}

const holding = () => client.getAccountBalance(N.VALUATION).then((r) => Number(r.message) || 0);

// ── a split ────────────────────────────────────────────────────────────

test('a split: the plan, the card, the run; and a second run or a second undo changes nothing', async () => {
  const s = await split('U1', 'U2', 'U3');
  const want = { kind: 'undo', reference: s.reference.toLowerCase() };
  const r = await undo.resolve(user, want);
  assert.equal(r.ok, true);
  assert.deepEqual(r.op, {
    kind: 'undo', reference: s.reference,
    target: { kind: 'split', job: null, direction: null, date: TODAY, status: 'posted' },
    docs: [{ step: 1, doctype: 'Stock Entry', name: s.entry }],
    lots: [{ code: 'U1', carats: 200, pieces: null, cost: 300000, location: 'stores', holder: null }],
    removed: ['U2', 'U3'],
    warnings: [],
  });
  // The gate signs the plan for the card and again for the save: it must come out the same.
  const again = await undo.resolve(user, want);
  assert.equal(lots.opSignature(again.op), lots.opSignature(r.op));
  assert.deepEqual(JSON.parse(JSON.stringify(r.op)), r.op);

  const { lines } = await undo.card(user, r.op);
  assert.deepEqual(lines, [
    `Take back: split of ${TODAY.replace(/-/g, '/')}`,
    `Ref: ${s.reference}`,
    'Cancelled in the books:',
    `- the stock movement (${s.entry})`,
    'Your lots afterwards:',
    '- U1: 200 ct, cost 300,000 THB, in stock',
    '- U2, U3: removed',
  ]);

  const done = await undo.run(user, client, r.op);
  assert.deepEqual(done, {
    ok: true, reference: s.reference, docs: [{ step: 1, doctype: 'Stock Entry', name: s.entry }], saved: null,
    lots: [{ code: 'U1', carats: 200, pieces: null, cost: 300000, location: 'stores' }], removed: ['U2', 'U3'],
    cancelled: [{ step: 1, doctype: 'Stock Entry', name: s.entry }], standing: [],
  });
  assert.equal(docstatus('Stock Entry', s.entry), 2);
  assert.equal(await h.batchQty(client, 'U1-TC', N.STORES), 200);
  assert.equal(await h.batchQty(client, 'U2-TC', N.STORES), 0);
  assert.deepEqual(facts(await lot('U1')), ['active', 200, null, 300000, 'stores', null]);
  assert.equal(await lot('U2'), null);
  assert.equal(await lot('U3'), null);
  assert.equal(await status(s.reference), 'undone');

  const calls = erp.calls.length;
  const twice = await undo.run(user, client, r.op);
  assert.equal(twice.ok, true);
  assert.equal(erp.calls.length, calls, 'nothing is sent to ERPNext for an operation that is already undone');
  const refused = await undo.resolve(user, want);
  assert.deepEqual(refused, { ok: false, error: `${s.reference} was already taken back.` });
});

// ── a transform with its fee document ─────────────────────────────────

test('a cut with a fee: the Repack is cancelled first, then the fee document; the holding account is back at zero', async () => {
  const je = await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: N.VALUATION, debit_in_account_currency: 2400 }, { account: N.CASH, credit_in_account_currency: 2400 }],
  });
  const fee = { doctype: 'Journal Entry', name: je.data.name };
  const c = await cut('T1', 'T2', fee);
  assert.equal(await holding(), 0);
  assert.deepEqual(facts(await lot('T2')), ['active', 30, 42, 272400, 'stores', null]);

  const r = await undo.resolve(user, { kind: 'undo', lot: 't2' });
  assert.equal(r.ok, true);
  assert.equal(r.op.reference, c.reference);
  assert.deepEqual(r.op.target, { kind: 'transform', job: 'cutting', direction: null, date: TODAY, status: 'posted' });
  assert.deepEqual(r.op.docs, [{ step: 2, doctype: 'Stock Entry', name: c.entry }, { step: 1, ...fee, amount: 2400, currency: 'THB' }]);
  assert.deepEqual(r.op.lots, [{ code: 'T1', carats: 120, pieces: null, cost: 270000, location: 'stores', holder: null }]);
  assert.deepEqual(r.op.removed, ['T2']);
  const { lines } = await undo.card(user, r.op);
  assert.equal(lines[0], `Take back: cutting of ${TODAY.replace(/-/g, '/')}`);
  assert.deepEqual(lines.slice(2, 5), ['Cancelled in the books:', `- the stock movement (${c.entry})`, `- the accounting entry for 2,400 THB (${fee.name})`]);

  const from = erp.calls.length;
  const done = await undo.run(user, client, r.op);
  assert.equal(done.ok, true);
  assert.deepEqual(done.docs.map((d) => d.name), [fee.name, c.entry]);
  assert.deepEqual(done.cancelled.map((d) => [d.doctype, d.name, d.amount]), [['Stock Entry', c.entry, undefined], ['Journal Entry', fee.name, 2400]]);
  assert.deepEqual(done.standing, []);
  const cancels = erp.calls.slice(from).filter((x) => /frappe\.client\.cancel/.test(x.url));
  assert.deepEqual(cancels.map((x) => x.body.name), [c.entry, fee.name]);
  assert.equal(docstatus('Stock Entry', c.entry), 2);
  assert.equal(docstatus('Journal Entry', fee.name), 2);
  assert.equal(await holding(), 0);
  assert.equal(await h.batchQty(client, 'T1-TC', N.STORES), 120);
  assert.deepEqual(facts(await lot('T1')), ['active', 120, null, 270000, 'stores', null]);
  assert.equal(await lot('T2'), null);
});

// ── moves ──────────────────────────────────────────────────────────────

test('a whole lot sent out for work: back in stock, the custody row gone', async () => {
  const m1 = await h.seedLot(user, client, { code: 'M1', carats: 50, pieces: 12, cost: 90000 });
  const entry = await h.stockEntry(client, 'Material Transfer', [
    h.row({ item_code: N.ROUGH, qty: 50, s_warehouse: N.STORES, t_warehouse: N.WORK, batch_no: 'M1-TC' }),
  ]);
  const sent = await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_work', holder: N.CUTTER, due_date: '2030-01-31',
    inputs: [h.input(m1)], outputs: [h.output({ lot: m1, carats: 50, pieces: 12, cost: 90000, to: 'work' })],
  }), { docs: [ste(entry.name)] });
  assert.deepEqual(facts(await lot('M1')), ['active', 50, 12, 90000, 'work', N.CUTTER]);
  assert.equal((await store.listCustody(user.id, { lot: 'M1' })).length, 1);

  const r = await undo.resolve(user, { kind: 'undo', reference: sent.op.reference });
  assert.deepEqual(r.op.lots, [{ code: 'M1', carats: 50, pieces: 12, cost: 90000, location: 'stores', holder: null }]);
  assert.deepEqual(r.op.removed, []);
  const { lines } = await undo.card(user, r.op);
  assert.equal(lines[0], `Take back: stones sent out for work of ${TODAY.replace(/-/g, '/')}`);
  assert.equal(lines.at(-1), '- M1: 50 ct, 12 pcs, cost 90,000 THB, in stock');

  const done = await undo.run(user, client, r.op);
  assert.equal(done.ok, true);
  assert.deepEqual(done.lots, [{ code: 'M1', carats: 50, pieces: 12, cost: 90000, location: 'stores' }]);
  assert.deepEqual(facts(await lot('M1')), ['active', 50, 12, 90000, 'stores', null]);
  assert.equal((await store.listCustody(user.id, { lot: 'M1', status: 'all' })).length, 0);
  assert.equal(await h.batchQty(client, 'M1-TC', N.STORES), 50);
  assert.equal(await h.batchQty(client, 'M1-TC', N.WORK), 0);
});

test('a part sent out on memo: the new lot goes, the carats and the pieces are back on the old one', async () => {
  const p1 = await h.seedLot(user, client, { code: 'P1', carats: 100, pieces: 20, cost: 50000 });
  await batch('P2');
  const entry = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 40, s_warehouse: N.STORES, batch_no: 'P1-TC' }),
    h.valued({ item_code: N.ROUGH, qty: 40, t_warehouse: N.MEMO, batch_no: 'P2-TC', basic_amount: 20000 }),
  ]);
  const sent = await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_memo', holder: 'Broker Lek', memo_price_per_ct: 900, due_date: '2030-02-15',
    inputs: [h.input(p1, { carats: 40, pieces: 8 })], outputs: [h.output({ code: 'P2', carats: 40, pieces: 8, cost: 20000, to: 'memo' })],
  }), { docs: [ste(entry.name)] });
  assert.deepEqual(facts(await lot('P1')), ['active', 60, 12, 30000, 'stores', null]);
  assert.deepEqual(facts(await lot('P2')), ['active', 40, 8, 20000, 'memo', 'Broker Lek']);

  // The lot the stones came from finds the same operation as the lot that was made.
  const r = await undo.resolve(user, { kind: 'undo', lot: 'P1' });
  assert.equal(r.op.reference, sent.op.reference);
  assert.deepEqual(r.op.lots, [{ code: 'P1', carats: 100, pieces: 20, cost: 50000, location: 'stores', holder: null }]);
  assert.deepEqual(r.op.removed, ['P2']);

  const done = await undo.run(user, client, r.op);
  assert.equal(done.ok, true);
  assert.deepEqual(facts(await lot('P1')), ['active', 100, 20, 50000, 'stores', null]);
  assert.equal(await lot('P2'), null);
  assert.equal((await store.listCustody(user.id, { status: 'all', lot: 'P2' })).length, 0);
  assert.equal(await h.batchQty(client, 'P1-TC', N.STORES), 100);
  assert.equal(await h.batchQty(client, 'P2-TC', N.MEMO), 0);
});

// ── what an undo refuses ───────────────────────────────────────────────

test('refused while a lot it made was used later; the later operation can go first', async () => {
  const s = await split('S1', 'S2', 'S3');
  const s2 = await lot('S2');
  const entry = await h.stockEntry(client, 'Material Transfer', [
    h.row({ item_code: N.ROUGH, qty: 120, s_warehouse: N.STORES, t_warehouse: N.WORK, batch_no: 'S2-TC' }),
  ]);
  const sent = await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_work', holder: N.CUTTER,
    inputs: [h.input(s2)], outputs: [h.output({ lot: s2, carats: 120, cost: 270000, to: 'work' })],
  }), { docs: [ste(entry.name)] });

  const r = await undo.resolve(user, { kind: 'undo', reference: s.reference });
  assert.deepEqual(r, { ok: false, error: `Lot S2 was used again after this (move ${sent.op.reference} on ${TODAY}). Undo that first.` });
  assert.equal(await status(s.reference), 'posted');

  // By lot the newest operation of that lot is meant, and with nothing named the newest of all.
  assert.equal((await undo.resolve(user, { kind: 'undo', lot: 'S2' })).op.reference, sent.op.reference);
  assert.equal((await undo.resolve(user, { kind: 'undo' })).op.reference, sent.op.reference);
  assert.equal((await undo.run(user, client, (await undo.resolve(user, { kind: 'undo' })).op)).ok, true);
  const now = await undo.resolve(user, { kind: 'undo', reference: s.reference });
  assert.equal(now.ok, true);
  assert.equal((await undo.run(user, client, now.op)).ok, true);
  assert.deepEqual(facts(await lot('S1')), ['active', 200, null, 300000, 'stores', null]);
});

test('a purchase and a sale: refused while the bill or invoice stands, in plain words; unknown references and other users', async () => {
  const b1 = await h.seedLot(user, client, { code: 'B1', carats: 10, cost: 5000 });
  const buy = await undo.resolve(user, { kind: 'undo', reference: b1.seed.op.reference });
  assert.equal(buy.ok, false);
  assert.match(buy.error, /is a purchase of stones\. A purchase cannot be taken back from here: its bill \(.+\) has to be cancelled in the books first, by the accountant\. Once that is done, ask for the undo again and the lots are put back\. Nothing was changed\./);

  erp._put('Sales Invoice', { name: 'SINV-UNDO-1', docstatus: 1, customer: N.CUSTOMER, grand_total: 2500, outstanding_amount: 2500, currency: 'THB' });
  const sale = await h.recordPosted(user, h.resolvedOp({
    kind: 'sell', counterparty: N.CUSTOMER, inputs: [h.input(b1, { carats: 4, cost: 2000 })],
  }), { docs: [{ doctype: 'Sales Invoice', name: 'SINV-UNDO-1' }] });
  const sell = await undo.resolve(user, { kind: 'undo', reference: sale.op.reference });
  assert.equal(sell.ok, false);
  assert.match(sell.error, /is a sale of stones\. A sale cannot be taken back from here: its invoice \(SINV-UNDO-1\) has to be cancelled in the books first/);
  assert.doesNotMatch(`${buy.error} ${sell.error}`, /Stock Entry|docstatus|ERPNext/);
  assert.deepEqual(facts(await lot('B1')), ['active', 6, null, 3000, 'stores', null]);

  // The run holds the same line when it is reached without a card.
  const forced = await undo.run(user, client, { kind: 'undo', reference: sale.op.reference });
  assert.equal(forced.ok, false);
  assert.equal(forced.partial, false);
  assert.match(forced.error, /has to be cancelled in the books first/);
  assert.equal(docstatus('Sales Invoice', 'SINV-UNDO-1'), 1);
  assert.equal(await status(sale.op.reference), 'posted');

  assert.deepEqual(await undo.resolve(user, { kind: 'undo', reference: 'LOT-NOPE' }), { ok: false, error: 'There is no stock operation with the reference LOT-NOPE.' });
  assert.deepEqual(await undo.resolve(user, { kind: 'undo', lot: 'ZZ9' }), { ok: false, error: 'There is no lot ZZ9.' });
  const other = await h.addUser();
  assert.equal((await undo.resolve(other, { kind: 'undo', reference: sale.op.reference })).ok, false);
  assert.deepEqual(await undo.resolve(other, { kind: 'undo' }), { ok: false, error: 'There is no stock operation to take back.' });
  const gone = await undo.run(other, client, { kind: 'undo', reference: sale.op.reference });
  assert.equal(gone.ok, false);
  assert.equal(gone.partial, false);
  assert.equal(await status(sale.op.reference), 'posted');
});

test('a sale and a purchase whose invoice and bill the accountant cancelled: the undo puts the lots back and cancels nothing', async () => {
  const b2 = await h.seedLot(user, client, { code: 'B2', carats: 10, cost: 5000 });
  erp._put('Sales Invoice', { name: 'SINV-UNDO-2', docstatus: 1, customer: N.CUSTOMER, grand_total: 2500, outstanding_amount: 2500, currency: 'THB' });
  const sale = await h.recordPosted(user, h.resolvedOp({
    kind: 'sell', counterparty: N.CUSTOMER, inputs: [h.input(b2, { carats: 4, cost: 2000 })],
  }), { docs: [{ doctype: 'Sales Invoice', name: 'SINV-UNDO-2' }] });
  assert.deepEqual(facts(await lot('B2')), ['active', 6, null, 3000, 'stores', null]);

  // The accountant cancels the invoice in the books.
  erp.get('Sales Invoice', 'SINV-UNDO-2').docstatus = 2;
  const cancels = [];
  const watched = { ...client, getResource: client.getResource.bind(client), cancelDoc: async (...a) => { cancels.push(a); return client.cancelDoc(...a); } };
  const plan = await undo.resolve(user, { kind: 'undo', reference: sale.op.reference }, { erp: watched });
  assert.equal(plan.ok, true, plan.error);
  assert.deepEqual(plan.op.docs.map((d) => d.name), ['SINV-UNDO-2']);
  const card = await undo.card(user, plan.op);
  assert.ok(card.lines.includes('Already cancelled in the books:'), card.lines.join('\n'));
  assert.ok(!card.lines.includes('Cancelled in the books:'));
  assert.ok(card.lines.some((l) => /^- B2: 10 ct/.test(l)), card.lines.join('\n'));

  const back = await undo.run(user, watched, plan.op);
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(cancels, []);
  assert.deepEqual(back.cancelled.map((d) => d.name), ['SINV-UNDO-2']);
  assert.deepEqual(back.standing, []);
  assert.equal(await status(sale.op.reference), 'undone');
  assert.deepEqual(facts(await lot('B2')), ['active', 10, null, 5000, 'stores', null]);

  // The purchase: its document cancelled in the books, then the lot it made goes.
  const stillThere = await undo.resolve(user, { kind: 'undo', reference: b2.seed.op.reference }, { erp: watched });
  assert.equal(stillThere.ok, false);
  await client.cancelDoc('Stock Entry', b2.seed.entry);
  const buyPlan = await undo.resolve(user, { kind: 'undo', reference: b2.seed.op.reference }, { erp: watched });
  assert.equal(buyPlan.ok, true, buyPlan.error);
  assert.deepEqual(buyPlan.op.removed, ['B2']);
  const bought = await undo.run(user, watched, buyPlan.op);
  assert.equal(bought.ok, true, bought.error);
  assert.deepEqual(cancels, []);
  assert.equal(await status(b2.seed.op.reference), 'undone');
  const after = await lot('B2');
  assert.ok(!after || after.status !== 'active');
});

// ── ERPNext refuses ────────────────────────────────────────────────────

/** A cut whose fee is a bill that is paid, as the accountant would have it: a bill (2,400) and a payment against it. */
async function paidFeeCut(code, into) {
  await client.createResource('Item', { item_code: 'Cutting fee', item_name: 'Cutting fee', is_stock_item: 0, is_purchase_item: 1 }).catch((err) => { if (err.status !== 409) throw err; });
  const bill = await client.createPurchaseInvoice({
    supplier: N.CUTTER, currency: 'THB', posting_date: TODAY, set_posting_time: 1, docstatus: 1, disable_rounded_total: 1,
    items: [{ item_code: 'Cutting fee', qty: 1, rate: 2400, expense_account: N.VALUATION, cost_center: N.COST_CENTER }],
  });
  const fee = { doctype: 'Purchase Invoice', name: bill.data.name };
  const c = await cut(code, into, fee);
  const pay = () => client.createPaymentEntry({
    payment_type: 'Pay', party_type: 'Supplier', party: N.CUTTER, posting_date: TODAY, paid_from: N.CASH, paid_to: N.CREDITORS,
    paid_amount: 2400, received_amount: 2400, source_exchange_rate: 1, target_exchange_rate: 1, docstatus: 1,
    references: [{ reference_doctype: 'Purchase Invoice', reference_name: bill.data.name, allocated_amount: 2400 }],
  });
  return { c, fee, pay };
}

test('a fee bill that is paid refuses the whole undo up front: nothing is cancelled, nothing moves', async () => {
  const { c, fee, pay } = await paidFeeCut('H1', 'H2');
  // The card was fine when it was made: the bill was not paid yet.
  const early = await undo.resolve(user, { kind: 'undo', reference: c.reference });
  assert.equal(early.ok, true);
  assert.deepEqual(early.op.docs.map((d) => [d.name, d.party, d.amount]), [[c.entry, undefined, undefined], [fee.name, N.CUTTER, 2400]]);
  assert.equal((await undo.card(user, early.op)).lines.includes(`- the bill from ${N.CUTTER} for 2,400 THB (${fee.name})`), true);
  const payment = await pay();

  // Asked again (the card), it is refused in plain words, before anything is touched.
  const calls = erp.calls.length;
  const r = await undo.resolve(user, { kind: 'undo', reference: c.reference });
  assert.equal(r.ok, false);
  assert.equal(r.error, `The bill from ${N.CUTTER} for 2,400 THB (${fee.name}) has a payment recorded against it, so this cannot be taken back while the payment stands. `
    + 'Nothing was changed. The payment has to be cancelled in the books first (the accountant can do it); then ask for the undo again.');
  assert.doesNotMatch(r.error, /Purchase Invoice|Payment Entry|ERPNext|docstatus/);
  assert.equal(erp.calls.slice(calls).some((x) => /cancel/.test(x.url)), false);

  // The same at the start of the run (the card was made before the payment): nothing cancelled, nothing moved.
  const stopped = await undo.run(user, client, early.op);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.partial, false, 'the operation is simply still saved');
  assert.equal(stopped.error, r.error);
  assert.deepEqual(stopped.cancelled, []);
  assert.deepEqual(stopped.standing.map((d) => [d.name, d.party, d.amount]), [[c.entry, undefined, undefined], [fee.name, N.CUTTER, 2400]]);
  assert.equal(docstatus('Stock Entry', c.entry), 1);
  assert.equal(docstatus('Purchase Invoice', fee.name), 1);
  assert.deepEqual(facts(await lot('H2')), ['active', 30, 42, 272400, 'stores', null]);
  assert.equal(await status(c.reference), 'posted');
  assert.deepEqual(await store.unfinishedOps(user.id), []);

  // Once the payment is cancelled the same undo goes through, both documents.
  await client.cancelDoc('Payment Entry', payment.data.name);
  const again = await undo.resolve(user, { kind: 'undo', reference: c.reference });
  assert.equal(again.ok, true);
  const done = await undo.run(user, client, again.op);
  assert.equal(done.ok, true);
  assert.deepEqual(done.cancelled.map((d) => d.name), [c.entry, fee.name]);
  assert.equal(docstatus('Purchase Invoice', fee.name), 2);
  assert.equal(await holding(), 0);
  assert.deepEqual(facts(await lot('H1')), ['active', 120, null, 270000, 'stores', null]);
  assert.equal(await lot('H2'), null);
});

test('a cancel refused after another document was cancelled waits as "undoing"; a second run finishes it', async () => {
  const { c, fee, pay } = await paidFeeCut('J1', 'J2');
  const payment = await pay();
  // ERPNext answers "not paid" while the bill is read, and refuses when it is cancelled: the up-front
  // check cannot see it, the cancel can.
  const blind = Object.create(client);
  blind.getResource = async (doctype, name) => {
    const r = await client.getResource(doctype, name);
    return doctype === 'Purchase Invoice' && name === fee.name ? { data: { ...r.data, outstanding_amount: r.data.grand_total } } : r;
  };
  const plan = await undo.resolve(user, { kind: 'undo', reference: c.reference }, { erp: blind });
  assert.equal(plan.ok, true);

  const stopped = await undo.run(user, blind, plan.op);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.partial, true);
  assert.deepEqual(stopped.docs, [{ step: 1, ...fee }]);
  assert.deepEqual(stopped.cancelled.map((d) => d.name), [c.entry]);
  assert.deepEqual(stopped.standing.map((d) => [d.name, d.party, d.amount]), [[fee.name, N.CUTTER, 2400]]);
  assert.match(stopped.error, new RegExp(`^The bill from ${N.CUTTER} for 2,400 THB \\(${fee.name}\\) could not be cancelled because a payment \\(${payment.data.name}\\) is recorded against it\\. `
    + 'That payment has to be cancelled in the books first'));
  assert.equal(docstatus('Stock Entry', c.entry), 2);
  assert.equal(docstatus('Purchase Invoice', fee.name), 1);
  // Berpal's lots are not touched until every document is cancelled.
  assert.deepEqual(facts(await lot('J2')), ['active', 30, 42, 272400, 'stores', null]);
  const waiting = await store.getOp(user.id, c.reference);
  assert.equal(waiting.status, 'undoing');
  assert.equal(waiting.error, stopped.error);
  assert.deepEqual(waiting.erpnext_docs.map((d) => [d.name, !!d.cancelled]), [[fee.name, false], [c.entry, true]]);
  assert.deepEqual((await store.unfinishedOps(user.id)).map((o) => o.reference), [c.reference]);

  // With the payment standing, the card now refuses outright (the bill is the only document left).
  assert.equal((await undo.resolve(user, { kind: 'undo' })).ok, false);
  await client.cancelDoc('Payment Entry', payment.data.name);
  const next = await undo.resolve(user, { kind: 'undo' });
  assert.equal(next.op.reference, c.reference);
  assert.equal(next.op.target.status, 'undoing');
  assert.deepEqual(next.op.docs.map((d) => d.name), [fee.name]);
  assert.match((await undo.card(user, next.op)).lines[0], /^Take back: cutting of .* \(partly taken back already\)$/);
  const done = await undo.run(user, client, next.op);
  assert.equal(done.ok, true);
  assert.deepEqual(done.docs.map((d) => d.name), [fee.name, c.entry]);
  assert.deepEqual(done.cancelled.map((d) => d.name), [c.entry, fee.name], 'both, the one cancelled earlier included');
  assert.deepEqual(done.standing, []);
  assert.equal(docstatus('Purchase Invoice', fee.name), 2);
  assert.equal(await holding(), 0);
  assert.deepEqual(facts(await lot('J1')), ['active', 120, null, 270000, 'stores', null]);
  assert.equal(await lot('J2'), null);
  assert.equal(await status(c.reference), 'undone');
  assert.deepEqual(await store.unfinishedOps(user.id), []);
});

test('refused at the first document: nothing was cancelled, so it is simply still saved (store.unmarkUndoing)', async (t) => {
  const s = await split('F1', 'F2', 'F3');
  // The accountant issued some of F2 straight in ERPNext: the Repack can no longer be cancelled.
  const issue = await h.stockEntry(client, 'Material Issue', [h.row({ item_code: N.ROUGH, qty: 20, s_warehouse: N.STORES, batch_no: 'F2-TC' })]);
  const r = await undo.resolve(user, { kind: 'undo', reference: s.reference });
  assert.equal(r.ok, true);

  // Without the store call the operation honestly stays 'undoing' and the result says so.
  const real = store.unmarkUndoing;
  t.after(() => { store.unmarkUndoing = real; });
  store.unmarkUndoing = undefined;
  const fallback = await undo.run(user, client, r.op);
  assert.equal(fallback.ok, false);
  assert.equal(fallback.partial, true);
  assert.match(fallback.error, new RegExp(`^The stock movement \\(${s.entry}\\) could not be cancelled because the books hold a later entry that used these stones`));
  assert.deepEqual(fallback.docs, [{ step: 1, doctype: 'Stock Entry', name: s.entry }]);
  assert.deepEqual([fallback.cancelled, fallback.standing.map((d) => d.name)], [[], [s.entry]]);
  assert.equal(await status(s.reference), 'undoing');
  assert.equal(docstatus('Stock Entry', s.entry), 1);
  assert.deepEqual(facts(await lot('F2')), ['active', 120, null, 270000, 'stores', null]);

  // With the real store call it goes back to 'posted' and nothing is partial.
  store.unmarkUndoing = real;
  assert.equal(typeof real, 'function');
  const again = await undo.resolve(user, { kind: 'undo', reference: s.reference });
  assert.equal(again.ok, true);
  assert.equal(again.op.target.status, 'undoing', 'it is still stuck as "undoing" until the next run puts it back');
  const refused = await undo.run(user, client, again.op);
  assert.equal(refused.ok, false);
  assert.equal(refused.partial, false);
  assert.match(refused.error, /could not be cancelled/);
  assert.equal(await status(s.reference), 'posted');
  assert.deepEqual(await store.unfinishedOps(user.id), []);

  // Once the later document is out of the way the same undo goes through.
  await client.cancelDoc('Stock Entry', issue.name);
  const fresh = await undo.resolve(user, { kind: 'undo', reference: s.reference });
  const done = await undo.run(user, client, fresh.op);
  assert.equal(done.ok, true);
  assert.deepEqual(facts(await lot('F1')), ['active', 200, null, 300000, 'stores', null]);
  assert.equal(await lot('F2'), null);
});

test('a refused undo of a half-saved operation does not stay "undoing": it is half saved again', async () => {
  const k1 = await h.seedLot(user, client, { code: 'Q1', carats: 30, cost: 9000 });
  await batch('Q2'); await batch('Q3');
  const entry = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 30, s_warehouse: N.STORES, batch_no: 'Q1-TC' }),
    h.valued({ item_code: N.ROUGH, qty: 10, t_warehouse: N.STORES, batch_no: 'Q2-TC', basic_amount: 3000 }),
    h.valued({ item_code: N.ROUGH, qty: 20, t_warehouse: N.STORES, batch_no: 'Q3-TC', basic_amount: 6000 }),
  ]);
  const begun = await store.beginOp(user, {
    op: h.resolvedOp({ kind: 'split', inputs: [h.input(k1)], outputs: [h.output({ code: 'Q2', carats: 10, cost: 3000 }), h.output({ code: 'Q3', carats: 20, cost: 6000 })] }),
  });
  await store.recordStep(begun.id, { step: 1, doctype: 'Stock Entry', name: entry.name });
  const issue = await h.stockEntry(client, 'Material Issue', [h.row({ item_code: N.ROUGH, qty: 5, s_warehouse: N.STORES, batch_no: 'Q2-TC' })]);

  const r = await undo.resolve(user, { kind: 'undo', reference: begun.reference });
  assert.equal(r.ok, true);
  const refused = await undo.run(user, client, r.op);
  assert.equal(refused.ok, false);
  assert.equal(refused.partial, true, 'still not finished: something was posted');
  assert.equal(await status(begun.reference), 'partial');
  assert.equal(docstatus('Stock Entry', entry.name), 1);
  // Not "undoing": it can be finished (retry) or taken back later, like before the attempt.
  assert.deepEqual((await store.unfinishedOps(user.id)).map((o) => [o.reference, o.status]), [[begun.reference, 'partial']]);

  await client.cancelDoc('Stock Entry', issue.name);
  const done = await undo.run(user, client, (await undo.resolve(user, { kind: 'undo', reference: begun.reference })).op);
  assert.equal(done.ok, true);
  assert.equal(await status(begun.reference), 'undone');
  assert.deepEqual(facts(await lot('Q1')), ['active', 30, null, 9000, 'stores', null]);
});

// ── what ERPNext says is not always clear ─────────────────────────────

test('a cancel with an unknown outcome (a timeout) leaves it "undoing" and is never put back; a retry finds out', async (t) => {
  const s = await split('T5', 'T6', 'T7');
  const real = store.unmarkUndoing;
  let called = 0;
  store.unmarkUndoing = async (...args) => { called++; return real(...args); };
  t.after(() => { store.unmarkUndoing = real; });

  // ERPNext does cancel it, but the answer never comes back, and neither does a look at the document.
  const timing = Object.create(client);
  const timeout = () => Object.assign(new Error('[erpnext POST /api/method/frappe.client.cancel] timeout'), { status: 504 });
  timing.cancelDoc = async (doctype, name) => {
    await client.cancelDoc(doctype, name);
    throw timeout();
  };
  timing.getResource = async (doctype, name) => { throw timeout(); };
  const plan = await undo.resolve(user, { kind: 'undo', reference: s.reference });
  const r = await undo.run(user, timing, plan.op);
  assert.equal(r.ok, false);
  assert.equal(r.partial, true);
  assert.equal(called, 0, 'never put back when it is not known');
  assert.equal(await status(s.reference), 'undoing');
  assert.match(r.error, /I could not tell whether the stock movement .* was cancelled/);
  assert.deepEqual([r.cancelled, r.standing.map((d) => d.name)], [[], [s.entry]]);
  assert.equal(docstatus('Stock Entry', s.entry), 2);
  assert.deepEqual(facts(await lot('T6')), ['active', 120, null, 270000, 'stores', null], 'the lots wait for the books');

  // The retry sees that it is cancelled and finishes. (A timeout that a look at the document can settle is settled: it is cancelled.)
  const again = await undo.resolve(user, { kind: 'undo', reference: s.reference });
  const done = await undo.run(user, client, again.op);
  assert.equal(done.ok, true);
  assert.equal(await lot('T6'), null);
  assert.equal(await status(s.reference), 'undone');
  assert.equal(called, 0);

  // A server error before anything happened: the same, and it is still not put back.
  const t2 = await split('T8', 'T9', 'T10');
  const failing = Object.create(client);
  failing.cancelDoc = async () => { const err = new Error('[erpnext POST /x] 502 bad gateway'); err.status = 502; throw err; };
  const r2 = await undo.run(user, failing, (await undo.resolve(user, { kind: 'undo', reference: t2.reference })).op);
  assert.equal(r2.partial, true);
  assert.equal(called, 0);
  assert.equal(await status(t2.reference), 'undoing');
  assert.equal(docstatus('Stock Entry', t2.entry), 1);
  assert.equal((await undo.run(user, client, (await undo.resolve(user, { kind: 'undo', reference: t2.reference })).op)).ok, true);
});

test('a 404 on cancel means there is nothing to cancel: it counts as done', async () => {
  const gone = await h.seedLot(user, client, { code: 'G1', carats: 20, cost: 4000 });
  const sent = await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_work', holder: N.CUTTER,
    inputs: [h.input(gone)], outputs: [h.output({ lot: gone, carats: 20, cost: 4000, to: 'work' })],
  }), { docs: [ste('MAT-STE-NEVER-WAS')] });
  const r = await undo.resolve(user, { kind: 'undo', reference: sent.op.reference });
  assert.equal(r.ok, true);
  const done = await undo.run(user, client, r.op);
  assert.equal(done.ok, true);
  assert.deepEqual(done.cancelled.map((d) => d.name), ['MAT-STE-NEVER-WAS']);
  assert.deepEqual(facts(await lot('G1')), ['active', 20, null, 4000, 'stores', null]);
  assert.equal(await status(sent.op.reference), 'undone');
});

test('a document the accountant already cancelled counts as done', async () => {
  const s = await split('A1', 'A2', 'A3');
  await client.cancelDoc('Stock Entry', s.entry);
  const r = await undo.resolve(user, { kind: 'undo', reference: s.reference });
  const done = await undo.run(user, client, r.op);
  assert.equal(done.ok, true);
  assert.deepEqual(facts(await lot('A1')), ['active', 200, null, 300000, 'stores', null]);
  assert.equal(await status(s.reference), 'undone');
});

// ── an operation that never finished saving ───────────────────────────

test('an operation stuck half saved: its document is cancelled and the lots stay as they are', async () => {
  const k1 = await h.seedLot(user, client, { code: 'K1', carats: 30, cost: 9000 });
  await batch('K2'); await batch('K3');
  const entry = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 30, s_warehouse: N.STORES, batch_no: 'K1-TC' }),
    h.valued({ item_code: N.ROUGH, qty: 10, t_warehouse: N.STORES, batch_no: 'K2-TC', basic_amount: 3000 }),
    h.valued({ item_code: N.ROUGH, qty: 20, t_warehouse: N.STORES, batch_no: 'K3-TC', basic_amount: 6000 }),
  ]);
  const begun = await store.beginOp(user, {
    op: h.resolvedOp({ kind: 'split', inputs: [h.input(k1)], outputs: [h.output({ code: 'K2', carats: 10, cost: 3000 }), h.output({ code: 'K3', carats: 20, cost: 6000 })] }),
    draft: null,
  });
  await store.recordStep(begun.id, { step: 1, doctype: 'Stock Entry', name: entry.name });

  const r = await undo.resolve(user, { kind: 'undo', lot: 'K1' });
  assert.equal(r.ok, true);
  assert.equal(r.op.reference, begun.reference);
  assert.equal(r.op.target.status, 'partial');
  assert.deepEqual([r.op.lots, r.op.removed], [[], []]);
  const { lines } = await undo.card(user, r.op);
  assert.match(lines[0], /^Take back: split of .* \(only partly saved\)$/);
  assert.equal(lines.at(-1), 'Your lots stay as they are now.');

  const done = await undo.run(user, client, r.op);
  assert.equal(done.ok, true);
  assert.deepEqual(done.lots, []);
  assert.equal(docstatus('Stock Entry', entry.name), 2);
  assert.equal(await h.batchQty(client, 'K1-TC', N.STORES), 30);
  assert.deepEqual(facts(await lot('K1')), ['active', 30, null, 9000, 'stores', null]);
  assert.equal(await status(begun.reference), 'undone');
  assert.deepEqual(await store.unfinishedOps(user.id), []);
});

// ── a document ERPNext holds that the record never got ────────────────

/** A split begun in Berpal ('pending') whose Repack reached ERPNext (with its remark) but was never recorded: the crash window. */
async function crashedSplit(code, a, b) {
  const src = await h.seedLot(user, client, { code, carats: 30, cost: 9000 });
  await batch(a); await batch(b);
  const begun = await store.beginOp(user, {
    op: h.resolvedOp({ kind: 'split', inputs: [h.input(src)], outputs: [h.output({ code: a, carats: 10, cost: 3000 }), h.output({ code: b, carats: 20, cost: 6000 })] }),
  });
  const entry = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 30, s_warehouse: N.STORES, batch_no: h.batchOf(code) }),
    h.valued({ item_code: N.ROUGH, qty: 10, t_warehouse: N.STORES, batch_no: h.batchOf(a), basic_amount: 3000 }),
    h.valued({ item_code: N.ROUGH, qty: 20, t_warehouse: N.STORES, batch_no: h.batchOf(b), basic_amount: 6000 }),
  ], { remarks: lots.remarkFor(begun.reference, 1, 1) });
  return { reference: begun.reference, id: begun.id, entry: entry.name };
}

test('a step that reached ERPNext but was never recorded is found, recorded and cancelled with the rest', async () => {
  const c = await crashedSplit('W1', 'W2', 'W3');
  assert.equal((await store.getOp(user.id, c.reference)).status, 'pending');
  assert.deepEqual((await store.getOp(user.id, c.reference)).erpnext_docs, []);

  const r = await undo.resolve(user, { kind: 'undo', lot: 'W1' });
  assert.equal(r.ok, true);
  assert.equal(r.op.reference, c.reference);
  assert.deepEqual(r.op.docs, [{ step: 1, doctype: 'Stock Entry', name: c.entry }]);
  assert.equal(r.op.target.status, 'partial', 'it now has a document on record');
  assert.deepEqual((await store.getOp(user.id, c.reference)).erpnext_docs, [{ step: 1, doctype: 'Stock Entry', name: c.entry }]);
  assert.deepEqual((await undo.card(user, r.op)).lines.slice(2, 4), ['Cancelled in the books:', `- the stock movement (${c.entry})`]);
  // The card and the save agree.
  assert.equal(lots.opSignature((await undo.resolve(user, { kind: 'undo', lot: 'W1' })).op), lots.opSignature(r.op));

  const done = await undo.run(user, client, r.op);
  assert.equal(done.ok, true);
  assert.deepEqual(done.cancelled, [{ step: 1, doctype: 'Stock Entry', name: c.entry }]);
  assert.equal(docstatus('Stock Entry', c.entry), 2);
  assert.equal(await h.batchQty(client, 'W1-TC', N.STORES), 30);
  assert.equal(await h.batchQty(client, 'W2-TC', N.STORES), 0);
  assert.equal(await status(c.reference), 'undone');
});

test('the run looks again for itself: an undo planned before the document turned up still cancels it', async () => {
  const src = await h.seedLot(user, client, { code: 'W4', carats: 30, cost: 9000 });
  await batch('W5'); await batch('W6');
  const begun = await store.beginOp(user, {
    op: h.resolvedOp({ kind: 'split', inputs: [h.input(src)], outputs: [h.output({ code: 'W5', carats: 10, cost: 3000 }), h.output({ code: 'W6', carats: 20, cost: 6000 })] }),
  });
  const planned = await undo.resolve(user, { kind: 'undo', reference: begun.reference });
  assert.deepEqual(planned.op.docs, [], 'nothing in the books yet');
  // The slow request lands after the card was made.
  const entry = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 30, s_warehouse: N.STORES, batch_no: 'W4-TC' }),
    h.valued({ item_code: N.ROUGH, qty: 10, t_warehouse: N.STORES, batch_no: 'W5-TC', basic_amount: 3000 }),
    h.valued({ item_code: N.ROUGH, qty: 20, t_warehouse: N.STORES, batch_no: 'W6-TC', basic_amount: 6000 }),
  ], { remarks: lots.remarkFor(begun.reference, 1, 1) });
  const done = await undo.run(user, client, planned.op);
  assert.equal(done.ok, true);
  assert.deepEqual(done.cancelled.map((d) => d.name), [entry.name]);
  assert.equal(docstatus('Stock Entry', entry.name), 2);
  assert.equal(await status(begun.reference), 'undone');
});

test('a fee entry that was posted but not recorded is found by its own remark and cancelled', async () => {
  const src = await h.seedLot(user, client, { code: 'W7', carats: 120, cost: 270000 });
  const op = h.resolvedOp({
    kind: 'transform', job: 'cutting', holder: N.CUTTER, fee: { amount: 2400, capitalised: 2400, basis: 'fixed' },
    inputs: [h.input(src)], outputs: [h.output({ code: 'W8', carats: 30, cost: 272400, form: 'cut' })],
  });
  const begun = await store.beginOp(user, { op, draft: { transaction_type: 'cash', amount: 2400 } });
  const before = await holding();
  const je = await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1, user_remark: lots.remarkFor(begun.reference, 1, 2),
    accounts: [{ account: N.VALUATION, debit_in_account_currency: 2400 }, { account: N.CASH, credit_in_account_currency: 2400 }],
  });
  assert.equal(await holding(), before + 2400);

  const r = await undo.resolve(user, { kind: 'undo', reference: begun.reference });
  assert.equal(r.ok, true);
  assert.deepEqual(r.op.docs, [{ step: 1, doctype: 'Journal Entry', name: je.data.name, amount: 2400, currency: 'THB' }]);
  assert.ok((await undo.card(user, r.op)).lines.includes(`- the accounting entry for 2,400 THB (${je.data.name})`));
  const done = await undo.run(user, client, r.op);
  assert.equal(done.ok, true);
  assert.equal(docstatus('Journal Entry', je.data.name), 2);
  assert.equal(await holding(), before);
  assert.equal(await status(begun.reference), 'undone');
});

test('if ERPNext cannot be searched the undo stops and says so: never "undone" without knowing', async () => {
  const c = await crashedSplit('W9', 'X2', 'X3');
  const down = Object.create(client);
  down.listResource = async () => { throw Object.assign(new Error('[erpnext GET /api/resource/Stock Entry] 503 gateway timeout'), { status: 503 }); };

  const card = await undo.resolve(user, { kind: 'undo', reference: c.reference }, { erp: down });
  assert.equal(card.ok, false);
  assert.match(card.error, new RegExp(`^I could not check what the books hold for ${c.reference} just now \\(.*503.*\\), and I will not take it back without knowing\\. Nothing was changed\\.`));
  assert.equal(await status(c.reference), 'pending', 'asking changed nothing');

  // The same at the start of the run (the card was made while ERPNext answered).
  const plan = await undo.resolve(user, { kind: 'undo', reference: c.reference }); // finds and records the entry
  assert.equal(plan.ok, true);
  const pretend = { ...plan.op, docs: [] };
  const lost = await store.getOp(user.id, c.reference);
  assert.equal(lost.erpnext_docs.length, 1);
  const r = await undo.run(user, down, pretend);
  assert.equal(r.ok, true, 'the entry is already on record, so there was nothing left to search for');
  assert.equal(await status(c.reference), 'undone');

  // A step that is not on record at all: the run stops when it cannot look.
  const d = await crashedSplit('Y9', 'Y8', 'Y7');
  const stopped = await undo.run(user, down, { kind: 'undo', reference: d.reference, docs: [], lots: [], removed: [] });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.partial, true);
  assert.match(stopped.error, /could not check what the books hold/);
  assert.equal(docstatus('Stock Entry', d.entry), 1);
  assert.equal(await status(d.reference), 'undoing', 'asked for, so a retry continues the undo and never the operation');
  assert.deepEqual(await h.batchQty(client, 'Y9-TC', N.STORES), 0);

  // When ERPNext answers again the entry is found (the record is reopened for it) and cancelled.
  const again = await undo.resolve(user, { kind: 'undo', reference: d.reference });
  assert.equal(again.ok, true);
  assert.deepEqual(again.op.docs.map((x) => x.name), [d.entry]);
  const done = await undo.run(user, client, again.op);
  assert.equal(done.ok, true);
  assert.equal(docstatus('Stock Entry', d.entry), 2);
  assert.equal(await h.batchQty(client, 'Y9-TC', N.STORES), 30);
  assert.equal(await status(d.reference), 'undone');
});

// ── a return from the holder, and what goes with removed lots ─────────

/** A lot sent out to the cutter (whole) and back again: the two moves, in ERPNext and in Berpal. */
async function outAndBack(code, { part = null } = {}) {
  const l = await h.seedLot(user, client, { code, carats: 50, pieces: 12, cost: 90000 });
  const batchOfLot = h.batchOf(code);
  const out = await h.stockEntry(client, 'Material Transfer', [h.row({ item_code: N.ROUGH, qty: 50, s_warehouse: N.STORES, t_warehouse: N.WORK, batch_no: batchOfLot })]);
  await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_work', holder: N.CUTTER, due_date: '2030-01-31',
    inputs: [h.input(l)], outputs: [h.output({ lot: l, carats: 50, pieces: 12, cost: 90000, to: 'work' })],
  }), { docs: [ste(out.name)] });
  const away = await lot(code);
  if (!part) {
    const back = await h.stockEntry(client, 'Material Transfer', [h.row({ item_code: N.ROUGH, qty: 50, s_warehouse: N.WORK, t_warehouse: N.STORES, batch_no: batchOfLot })]);
    const done = await h.recordPosted(user, h.resolvedOp({
      kind: 'move', direction: 'return', holder: N.CUTTER,
      inputs: [h.input(away)], outputs: [h.output({ lot: away, carats: 50, pieces: 12, cost: 90000, to: 'stores' })],
    }), { docs: [ste(back.name)] });
    return { reference: done.op.reference, entry: back.name };
  }
  await batch(part);
  const back = await h.stockEntry(client, 'Repack', [
    h.row({ item_code: N.ROUGH, qty: 20, s_warehouse: N.WORK, batch_no: batchOfLot }),
    h.valued({ item_code: N.ROUGH, qty: 20, t_warehouse: N.STORES, batch_no: h.batchOf(part), basic_amount: 36000 }),
  ]);
  const done = await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'return', holder: N.CUTTER,
    inputs: [h.input(away, { carats: 20, pieces: 5 })], outputs: [h.output({ code: part, carats: 20, pieces: 5, cost: 36000, to: 'stores' })],
  }), { docs: [ste(back.name)] });
  return { reference: done.op.reference, entry: back.name };
}

test('undo of a return from the holder: the stones are out again, with the cutter, and the custody row is open again', async () => {
  const r1 = await outAndBack('B7');
  assert.deepEqual(facts(await lot('B7')), ['active', 50, 12, 90000, 'stores', null]);
  assert.deepEqual((await store.listCustody(user.id, { lot: 'B7' })).length, 0, 'it was returned');

  const plan = await undo.resolve(user, { kind: 'undo', lot: 'B7' });
  assert.equal(plan.ok, true);
  assert.equal(plan.op.reference, r1.reference);
  assert.equal((await undo.card(user, plan.op)).lines[0], `Take back: stones taken back in of ${TODAY.replace(/-/g, '/')}`);
  assert.deepEqual(plan.op.lots, [{ code: 'B7', carats: 50, pieces: 12, cost: 90000, location: 'work', holder: N.CUTTER }]);
  assert.equal((await undo.card(user, plan.op)).lines.at(-1), `- B7: 50 ct, 12 pcs, cost 90,000 THB, out for work with ${N.CUTTER}`);

  const done = await undo.run(user, client, plan.op);
  assert.equal(done.ok, true);
  assert.deepEqual(facts(await lot('B7')), ['active', 50, 12, 90000, 'work', N.CUTTER]);
  const open = await store.listCustody(user.id, { lot: 'B7' });
  assert.deepEqual(open.map((c) => [c.holder, c.status, c.carats_out, c.carats_returned]), [[N.CUTTER, 'out', 50, 0]]);
  assert.equal(await h.batchQty(client, 'B7-TC', N.WORK), 50);
  assert.equal(await h.batchQty(client, 'B7-TC', N.STORES), 0);
});

test('undo of a part coming back: the new lot goes and the carats are with the holder again', async () => {
  const r = await outAndBack('B8', { part: 'B9' });
  assert.deepEqual(facts(await lot('B8')), ['active', 30, 7, 54000, 'work', N.CUTTER]);
  assert.deepEqual(facts(await lot('B9')), ['active', 20, 5, 36000, 'stores', null]);

  const plan = await undo.resolve(user, { kind: 'undo', reference: r.reference });
  assert.deepEqual(plan.op.lots, [{ code: 'B8', carats: 50, pieces: 12, cost: 90000, location: 'work', holder: N.CUTTER }]);
  assert.deepEqual(plan.op.removed, ['B9']);
  const done = await undo.run(user, client, plan.op);
  assert.equal(done.ok, true);
  assert.deepEqual(facts(await lot('B8')), ['active', 50, 12, 90000, 'work', N.CUTTER]);
  assert.equal(await lot('B9'), null);
  assert.deepEqual((await store.listCustody(user.id, { lot: 'B8' })).map((c) => [c.status, c.carats_out, c.carats_returned]), [['out', 50, 0]]);
  assert.equal(await h.batchQty(client, 'B8-TC', N.WORK), 50);
});

test('the card says what goes with the removed lots: certificates, and details changed since', async () => {
  const s = await split('Z1', 'Z2', 'Z3');
  await store.addCertificate(user.id, 'Z2', { lab: 'GIA', report_no: '1234567890' });
  const plan = await undo.resolve(user, { kind: 'undo', reference: s.reference });
  assert.deepEqual(plan.op.losses, { certificates: [{ lot: 'Z2', lab: 'GIA', report_no: '1234567890' }], detailsChanged: [] });
  assert.ok((await undo.card(user, plan.op)).lines.includes('Certificates that go with the removed lots: GIA 1234567890 (Z2)'));

  // A lot that is only re-used (sent out): the details the trader changed afterwards go back.
  const m = await h.seedLot(user, client, { code: 'Z4', carats: 10, cost: 1000 });
  const entry = await h.stockEntry(client, 'Material Transfer', [h.row({ item_code: N.ROUGH, qty: 10, s_warehouse: N.STORES, t_warehouse: N.WORK, batch_no: 'Z4-TC' })]);
  const sent = await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_work', holder: N.CUTTER, inputs: [h.input(m)], outputs: [h.output({ lot: m, carats: 10, cost: 1000, to: 'work' })],
  }), { docs: [ste(entry.name)] });
  await store.setDetails(user.id, 'Z4', { colour: 'blue' });
  const p2 = await undo.resolve(user, { kind: 'undo', reference: sent.op.reference });
  assert.deepEqual(p2.op.losses, { certificates: [], detailsChanged: ['Z4'] });
  assert.ok((await undo.card(user, p2.op)).lines.includes('Details you changed on Z4 after this go back to what they were'));
  // Nothing to lose: no such lines, and no `losses` in the plan.
  const clean = await undo.resolve(user, { kind: 'undo', reference: (await split('Z5', 'Z6', 'Z7')).reference });
  assert.equal('losses' in clean.op, false);
  assert.equal((await undo.card(user, clean.op)).lines.some((l) => /Certificates|Details you changed/.test(l)), false);
});

// ── through the confirmation gate ─────────────────────────────────────

/** request_confirmation, then the user's "yes" on the next turn (handle() promotes the signature), then save_transaction. */
async function viaGate(ctx) {
  const asked = await gate.requestConfirmation(ctx);
  if (!asked.ok) return { asked };
  ctx.draft.confirmation_pending = ctx.draft.confirmation_sig;
  return { asked, saved: await gate.saveTransaction(ctx) };
}

test('through the gate: the card, the confirmation, the cancel, the review comment', async () => {
  const s = await split('GA', 'GB', 'GC');
  const ctx = h.ctxFor(user, { stock_op: { kind: 'undo', reference: s.reference } });
  const { asked, saved } = await viaGate(ctx);
  assert.equal(asked.ok, true);
  assert.equal(asked.card.lines[0], `Take back: split of ${TODAY.replace(/-/g, '/')}`);
  assert.ok(asked.card.lines.includes(`- the stock movement (${s.entry})`));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.reference, s.reference);
  assert.deepEqual(saved.documents.map((d) => d.name), [s.entry]);
  assert.deepEqual(saved.lots.map((l) => [l.code, l.carats]), [['GA', 200]]);
  assert.equal(docstatus('Stock Entry', s.entry), 2);
  assert.equal(await status(s.reference), 'undone');
  assert.deepEqual(facts(await lot('GA')), ['active', 200, null, 300000, 'stores', null]);
  assert.equal(await lot('GB'), null);
  assert.deepEqual(ctx.draft, {});
  assert.ok(erp.all('Comment').some((c) => c.reference_name === s.entry && /taken back from WhatsApp/.test(c.content)), 'the cancelled stock entry says so');
});

test('through the gate: a paid fee bill is refused at the card, in plain words', async () => {
  const { c, pay } = await paidFeeCut('GD', 'GE');
  const payment = await pay();
  const ctx = h.ctxFor(user, { stock_op: { kind: 'undo', reference: c.reference } });
  const { asked } = await viaGate(ctx);
  assert.equal(asked.ok, false);
  assert.match(asked.error, /has a payment recorded against it, so this cannot be taken back while the payment stands\. Nothing was changed\./);
  assert.equal(docstatus('Stock Entry', c.entry), 1);
  assert.equal(await status(c.reference), 'posted');
  await client.cancelDoc('Payment Entry', payment.data.name);
  assert.equal((await viaGate(h.ctxFor(user, { stock_op: { kind: 'undo', reference: c.reference } }))).saved.ok, true);
});

test('through the gate: an answer that never came leaves it undoing, and retry_stock_op finishes it', async () => {
  const s = await split('GF', 'GG', 'GH');
  const ctx = h.ctxFor(user, { stock_op: { kind: 'undo', reference: s.reference } });
  ctx.erp = Object.assign(Object.create(client), {
    cancelDoc: async () => { throw Object.assign(new Error('[erpnext POST /x] 504 timeout'), { status: 504 }); },
  });
  const { saved } = await viaGate(ctx);
  assert.equal(saved.ok, false);
  assert.equal(saved.partial, true);
  assert.equal(await status(s.reference), 'undoing');
  assert.equal(docstatus('Stock Entry', s.entry), 1);

  const retry = h.ctxFor(user, {});
  const r = await gate.retry(retry);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await status(s.reference), 'undone');
  assert.equal(docstatus('Stock Entry', s.entry), 2);
});
