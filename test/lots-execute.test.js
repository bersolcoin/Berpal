/**
 * Running a confirmed lot operation (src/lots/execute.js) against the fake ERPNext: which
 * documents each kind posts, what they do to stock and the ledger, what comes back into the lot
 * rows, and what happens when a step fails (refused, half done, no answer) and is tried again.
 *
 * The first half replays the worked example of docs/parcel-lot-stock-design.md section 6 through
 * run(), to the satang. Steps share state and run in order. Operations are built by hand
 * (lots-helpers), the way the resolver hands them over; expected figures are worked out in the
 * comments, never by calling the code under test.
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

const { N, TODAY, WORKED } = h;
const erp = new FakeErpNext();
let user; let client;
const ids = {};

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
});

const STOCK_LOSS = 'Stock Loss - TC';
const lot = (code) => store.getLot(user.id, code);
const facts = (l) => l && [l.status, l.carats, l.cost, l.location];
const status = async (reference, u = user) => (await store.getOp(u.id, reference)).status;
const run = (op, draft = null, u = user) => execute.run(u, client, { op, draft });
const shown = (r) => r.lots.map((l) => [l.code, l.carats, l.cost, l.location]);

/** Net Dr − Cr (company currency) per account over the GL rows of a voucher; zero nets dropped. */
function gl(voucherNo) {
  const out = {};
  for (const g of erp.all('GL Entry').filter((x) => x.voucher_no === voucherNo)) {
    out[g.account] = Math.round(((out[g.account] || 0) + g.debit - g.credit) * 100) / 100;
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}
const balance = async (account) => (await client.getAccountBalance(account, TODAY)).message;
/** Submitted documents of a doctype that carry this text in their remark. */
const marked = (doctype, text) => erp.all(doctype).filter((d) => `${d.remarks || ''}${d.user_remark || ''}`.includes(text) && d.docstatus === 1);
const posted = (doctype) => erp.calls.filter((c) => c.method === 'POST' && decodeURIComponent(c.url).endsWith(`/api/resource/${doctype}`)).length;

const bill = (items, extra = {}) => ({
  transaction_type: 'bill_received', direction: 'expense', currency: 'THB', transaction_date: TODAY, category_code: '5000',
  counterparty_name: N.SUPPLIER, counterparty_contact_skipped: true, payment_terms: 'net_30',
  amount: items.reduce((s, i) => s + i.qty * i.rate, 0), items, ...extra,
});
const invoice = (items, extra = {}) => ({
  transaction_type: 'invoice_issued', direction: 'income', currency: 'THB', transaction_date: TODAY, category_code: '4000',
  counterparty_name: N.CUSTOMER, counterparty_contact_skipped: true, payment_terms: 'net_30',
  amount: items.reduce((s, i) => s + i.qty * i.rate, 0), items, ...extra,
});
/** The fee of a job, paid from the cash box unless `extra` says otherwise. */
const fee = (amount, extra = {}) => ({
  transaction_type: 'cash', direction: 'expense', currency: 'THB', transaction_date: TODAY, category_code: lots.FEE_CATEGORY_CODE,
  counterparty_name: N.CUTTER, counterparty_contact_skipped: true, amount, description: 'Cutting fee', ...extra,
});
/** A lot line the way the gate leaves it: qty 1 at the line total. */
const lotLine = (code, carats, total, extra = {}) => ({ description: `Sapphire ${code}`, qty: 1, rate: total, lot: { code, carats, ...extra } });

/** Replace fetch for the length of `fn`; `hook(real, url, opts)` answers each request. */
async function withFetch(hook, fn) {
  const real = global.fetch;
  global.fetch = (url, opts = {}) => hook(real, url, opts);
  try { return await fn(); } finally { global.fetch = real; }
}
const creates = (doctype, url, opts) => opts.method === 'POST' && decodeURIComponent(new URL(url).pathname) === `/api/resource/${doctype}`;
const answer = (status, exception) => ({ ok: false, status, text: async () => JSON.stringify({ exception }) });

// ── what an operation posts ────────────────────────────────────────────

test('steps: the documents of each kind, in posting order', () => {
  const s = (op, draft) => execute.steps(h.resolvedOp(op), draft).map((x) => `${x.step} ${x.doctype} ${x.what}`);
  assert.deepEqual(s({ kind: 'buy' }), ['1 Purchase Invoice bill']);
  assert.deepEqual(s({ kind: 'sell' }), ['1 Sales Invoice invoice']);
  assert.deepEqual(s({ kind: 'split' }), ['1 Stock Entry repack']);
  assert.deepEqual(s({ kind: 'merge' }), ['1 Stock Entry repack']);
  assert.deepEqual(s({ kind: 'transform' }), ['1 Stock Entry repack']);
  const paid = { amount: 2400, capitalised: 2400, basis: 'fixed' };
  assert.deepEqual(s({ kind: 'transform', fee: paid }, fee(2400)), ['1 Journal Entry fee', '2 Stock Entry repack']);
  assert.deepEqual(s({ kind: 'transform', fee: paid }, fee(2400, { transaction_type: 'bill_received' })), ['1 Purchase Invoice fee', '2 Stock Entry repack']);
  assert.deepEqual(s({ kind: 'write_off' }), ['1 Stock Entry issue']);
  // A move is a transfer only when every lot goes as it is.
  const whole = { lot_id: 7, whole: true, carats: 8 };
  assert.deepEqual(s({ kind: 'move', inputs: [whole], outputs: [{ new: false, lot_id: 7, carats: 8 }] }), ['1 Stock Entry transfer']);
  assert.deepEqual(s({ kind: 'move', inputs: [{ ...whole, whole: false, carats: 3 }], outputs: [{ new: true, lot_id: null, carats: 3 }] }), ['1 Stock Entry repack']);
  assert.throws(() => execute.steps({ kind: 'undo' }), /Not a lot operation/);
});

// ── the worked example ─────────────────────────────────────────────────

test('buy: 200 ct of rough for 300,000 is one bill that brings lot L12 into Stores', async () => {
  const draft = bill([lotLine('L12', 200, 300000)], { invoice_number: 'MR-881' });
  const op = h.resolvedOp({
    kind: 'buy', counterparty: N.SUPPLIER,
    outputs: [h.output({ code: 'L12', carats: 200, cost: 300000, line: 0, attrs: { species: 'sapphire', description: 'Mogok rough' } })],
  });
  const r = await run(op, draft);
  assert.equal(r.ok, true, r.error);
  assert.match(r.reference, /\S/);
  assert.deepEqual(r.docs.map((d) => [d.step, d.doctype]), [[1, 'Purchase Invoice']]);
  assert.deepEqual(r.saved, { doctype: 'Purchase Invoice', erpnext_name: r.docs[0].name });
  assert.deepEqual(r.money_doc, r.saved);
  assert.deepEqual(shown(r), [['L12', 200, 300000, 'stores']]);
  ids.buy = r.docs[0].name;

  const pi = erp.get('Purchase Invoice', ids.buy);
  assert.equal(pi.update_stock, 1);
  assert.equal(pi.grand_total, 300000);
  assert.equal(pi.bill_no, 'MR-881');
  assert.equal(pi.remarks, lots.remarkFor(r.reference, 1, 1));
  assert.equal(pi.items.length, 1);
  // 300,000 / 200 ct = 1,500.00 per carat exactly: no rounding row.
  const row = pi.items[0];
  assert.deepEqual([row.item_code, row.qty, row.rate, row.uom, row.warehouse, row.batch_no], [N.ROUGH, 200, 1500, 'Carat', N.STORES, 'L12-TC']);
  assert.deepEqual(gl(ids.buy), { [N.STOCK]: 300000, [N.CREDITORS]: -300000 });
  assert.deepEqual(erp.batchValue('L12-TC', N.STORES), { qty: 200, value: 300000 });
  assert.equal(erp.get('Batch', 'L12-TC').description, 'Mogok rough');

  const l12 = await lot('L12');
  assert.deepEqual(facts(l12), ['active', 200, 300000, 'stores']);
  assert.deepEqual([l12.erpnext_item, l12.erpnext_batch], [N.ROUGH, 'L12-TC']);
  assert.equal(await status(r.reference), 'posted');
});

test('sort: L12 splits into L13 (270,000) and L14 (30,000) with one Repack', async () => {
  const [a, b] = WORKED.split1;
  const op = h.resolvedOp({
    kind: 'split', inputs: [h.input(await lot('L12'))],
    outputs: [h.output({ code: a.code, carats: a.carats, cost: a.cost }), h.output({ code: b.code, carats: b.carats, cost: b.cost })],
  });
  const r = await run(op);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.docs.map((d) => [d.step, d.doctype]), [[1, 'Stock Entry']]);
  assert.deepEqual(r.saved, { doctype: 'Stock Entry', erpnext_name: r.docs[0].name });
  assert.equal(r.money_doc, null);
  assert.deepEqual(shown(r), [['L13', 120, 270000, 'stores'], ['L14', 80, 30000, 'stores'], ['L12', 0, 0, 'stores']]);

  const se = erp.get('Stock Entry', r.docs[0].name);
  assert.equal(se.stock_entry_type, 'Repack');
  assert.equal(se.remarks, lots.remarkFor(r.reference, 1, 1));
  assert.deepEqual(se.items.map((i) => [i.batch_no, i.qty, i.s_warehouse || null, i.t_warehouse || null]), [
    ['L12-TC', 200, N.STORES, null], ['L13-TC', 120, null, N.STORES], ['L14-TC', 80, null, N.STORES],
  ]);
  assert.deepEqual(erp.batchValue('L12-TC', N.STORES), { qty: 0, value: 0 });
  assert.deepEqual(erp.batchValue('L13-TC', N.STORES), { qty: 120, value: 270000 });
  assert.deepEqual(erp.batchValue('L14-TC', N.STORES), { qty: 80, value: 30000 });
  assert.deepEqual(gl(se.name), {}, 'value only changes lot, nothing reaches the ledger');
  assert.equal((await lot('L12')).status, 'closed');
});

test('send to the cutter: the whole of L13 goes out for work with one Material Transfer', async () => {
  const l13 = await lot('L13');
  const op = h.resolvedOp({
    kind: 'move', direction: 'out_work', holder: N.CUTTER,
    inputs: [h.input(l13)], outputs: [h.output({ lot: l13, carats: 120, cost: 270000, to: 'work' })],
  });
  const r = await run(op);
  assert.equal(r.ok, true, r.error);
  const se = erp.get('Stock Entry', r.docs[0].name);
  assert.equal(se.stock_entry_type, 'Material Transfer');
  assert.deepEqual(se.items.map((i) => [i.batch_no, i.qty, i.s_warehouse, i.t_warehouse]), [['L13-TC', 120, N.STORES, N.WORK]]);
  assert.deepEqual(gl(se.name), {});
  assert.deepEqual(erp.batchValue('L13-TC', N.WORK), { qty: 120, value: 270000 });
  assert.deepEqual(shown(r), [['L13', 120, 270000, 'work']]);
  const after = await lot('L13');
  assert.deepEqual([...facts(after), after.holder, after.erpnext_batch], ['active', 120, 270000, 'work', N.CUTTER, 'L13-TC']);
});

test('cut: the fee is paid into the holding account, then one Repack takes it into lot L15', async () => {
  const c = WORKED.cut;
  const op = h.resolvedOp({
    kind: 'transform', job: 'cutting', holder: N.CUTTER, yield_pct: c.yield_pct, loss_carats: 90,
    inputs: [h.input(await lot('L13'))],
    outputs: [h.output({ code: c.code, carats: c.carats, pieces: c.pieces, cost: c.cost, form: 'cut' })],
    fee: { amount: c.fee, capitalised: c.fee, basis: 'fixed' },
  });
  const r = await run(op, fee(c.fee, { description: 'Cutting L13' }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.docs.map((d) => [d.step, d.doctype]), [[1, 'Journal Entry'], [2, 'Stock Entry']]);
  assert.deepEqual(r.money_doc, { doctype: 'Journal Entry', erpnext_name: r.docs[0].name });
  assert.deepEqual(r.saved, { doctype: 'Stock Entry', erpnext_name: r.docs[1].name });
  assert.deepEqual(shown(r), [['L15', 30, 272400, 'stores'], ['L13', 0, 0, 'work']]);

  // The fee: Dr 5118 2,400 / Cr cash 2,400, findable by its step remark.
  const je = erp.get('Journal Entry', r.docs[0].name);
  assert.equal(je.user_remark, `${lots.remarkFor(r.reference, 1, 2)} | Cutting L13`);
  assert.deepEqual(gl(je.name), { [N.VALUATION]: 2400, [N.CASH]: -2400 });
  // The Repack: 120 ct of rough out of work (270,000), 30 ct cut into Stores at 270,000 + 2,400.
  const se = erp.get('Stock Entry', r.docs[1].name);
  assert.equal(se.stock_entry_type, 'Repack');
  assert.equal(se.remarks, lots.remarkFor(r.reference, 2, 2));
  assert.deepEqual(se.items.map((i) => [i.item_code, i.batch_no, i.qty, i.s_warehouse || null, i.t_warehouse || null]), [
    [N.ROUGH, 'L13-TC', 120, N.WORK, null], [N.CUT, 'L15-TC', 30, null, N.STORES],
  ]);
  assert.deepEqual(se.additional_costs.map((a) => [a.expense_account, a.amount]), [[N.VALUATION, 2400]]);
  assert.deepEqual(gl(se.name), { [N.STOCK]: 2400, [N.VALUATION]: -2400 });
  assert.deepEqual(erp.batchValue('L15-TC', N.STORES), { qty: 30, value: 272400 });
  assert.deepEqual(erp.batchValue('L13-TC', N.WORK), { qty: 0, value: 0 });
  assert.equal(await balance(N.VALUATION), 0, 'the holding account nets to zero');
  assert.equal(await balance(N.STOCK), 302400);

  const l15 = await lot('L15');
  assert.deepEqual([...facts(l15), l15.pieces, l15.erpnext_item, l15.erpnext_batch], ['active', 30, 272400, 'stores', 42, N.CUT, 'L15-TC']);
});

test('grade: L15 splits into L16 (175,741.94) and L17 (96,658.06)', async () => {
  const [a, b] = WORKED.split2;
  const op = h.resolvedOp({
    kind: 'split', inputs: [h.input(await lot('L15'))],
    outputs: [h.output({ code: a.code, carats: a.carats, cost: a.cost, form: 'cut' }), h.output({ code: b.code, carats: b.carats, cost: b.cost, form: 'cut' })],
  });
  const r = await run(op);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(shown(r), [['L16', 8, 175741.94, 'stores'], ['L17', 22, 96658.06, 'stores'], ['L15', 0, 0, 'stores']]);
  assert.deepEqual(erp.batchValue('L16-TC', N.STORES), { qty: 8, value: 175741.94 });
  assert.deepEqual(erp.batchValue('L17-TC', N.STORES), { qty: 22, value: 96658.06 });
  assert.deepEqual(gl(r.docs[0].name), {}); // 175,741.94 + 96,658.06 = 272,400.00 exactly
  assert.equal(await balance(N.STOCK), 302400);
});

test('memo: the whole of L16 goes out on memo', async () => {
  const l16 = await lot('L16');
  const r = await run(h.resolvedOp({
    kind: 'move', direction: 'out_memo', holder: N.CUSTOMER, memo_price_per_ct: 30000,
    inputs: [h.input(l16)], outputs: [h.output({ lot: l16, carats: 8, cost: 175741.94, to: 'memo', form: 'cut' })],
  }));
  assert.equal(r.ok, true, r.error);
  assert.equal(erp.get('Stock Entry', r.docs[0].name).stock_entry_type, 'Material Transfer');
  assert.deepEqual(erp.batchValue('L16-TC', N.MEMO), { qty: 8, value: 175741.94 });
  assert.deepEqual(shown(r), [['L16', 8, 175741.94, 'memo']]);
});

test('memo sale: 5.5 ct of L16 sold from memo for 165,000; cost of sales is L16\'s own', async () => {
  const s = WORKED.sale;
  const draft = invoice([lotLine('L16', 5.5, 165000)]);
  // 5.5 × 175,741.94 / 8 = 120,822.58375 → 120,822.58 (h.input works the planned cost out the same way).
  const op = h.resolvedOp({ kind: 'sell', counterparty: N.CUSTOMER, inputs: [h.input(await lot('L16'), { carats: 5.5 })] });
  assert.equal(op.inputs[0].cost, s.cogs);
  const r = await run(op, draft);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.docs.map((d) => [d.step, d.doctype]), [[1, 'Sales Invoice']]);
  assert.deepEqual(r.saved, { doctype: 'Sales Invoice', erpnext_name: r.docs[0].name });
  assert.deepEqual(r.money_doc, r.saved);
  assert.deepEqual(shown(r), [['L16', s.left_carats, s.left_cost, 'memo']]);

  const si = erp.get('Sales Invoice', r.docs[0].name);
  assert.equal(si.update_stock, 1);
  assert.equal(si.grand_total, 165000);
  assert.equal(si.remarks, lots.remarkFor(r.reference, 1, 1));
  const row = si.items[0];
  assert.deepEqual([row.item_code, row.qty, row.rate, row.warehouse, row.batch_no, row.expense_account], [N.CUT, 5.5, 30000, N.MEMO, 'L16-TC', N.COGS]);
  assert.deepEqual(gl(si.name), { [N.DEBTORS]: 165000, [N.SALES]: -165000, [N.COGS]: 120822.58, [N.STOCK]: -120822.58 });
  assert.deepEqual(erp.batchValue('L16-TC', N.MEMO), { qty: 2.5, value: 54919.36 }); // 175,741.94 − 120,822.58
  assert.deepEqual(facts(await lot('L16')), ['active', 2.5, 54919.36, 'memo']);
  assert.equal(await balance(N.STOCK), 181577.42); // 302,400 − 120,822.58
});

// ── bills and invoices ─────────────────────────────────────────────────

test('a bill with two lots and a plain line totals what the draft says; a rate that cannot be exact leaves a rounding row', async () => {
  // B1: 7.3 ct for 10,000. 10,000 / 7.3 = 1,369.863…; at 1,369.86 the row is 7.3 × 1,369.86 =
  // 9,999.978 → 9,999.98, so 0.02 goes on a rounding row (to the bill's expense account).
  // B2: 12.5 ct for 25,000 = 2,000.00 per carat. Plus 350 of shipping that is no lot.
  const draft = bill([lotLine('B1', 7.3, 10000), { description: 'Shipping', qty: 1, rate: 350 }, lotLine('B2', 12.5, 25000)]);
  const op = h.resolvedOp({
    kind: 'buy', counterparty: N.SUPPLIER,
    outputs: [h.output({ code: 'B1', carats: 7.3, cost: 10000, line: 0 }), h.output({ code: 'B2', carats: 12.5, cost: 25000, line: 2, form: 'cut' })],
  });
  const r = await run(op, draft);
  assert.equal(r.ok, true, r.error);
  const pi = erp.get('Purchase Invoice', r.docs[0].name);
  assert.equal(pi.grand_total, 35350, 'what the card showed');
  assert.deepEqual(pi.items.map((i) => [i.item_code, i.qty, i.rate, i.batch_no || null, i.warehouse || null]), [
    [N.ROUGH, 7.3, 1369.86, 'B1-TC', N.STORES],
    ['GEN-PURCHASE', 1, 0.02, null, null],
    ['GEN-PURCHASE', 1, 350, null, null],
    [N.CUT, 12.5, 2000, 'B2-TC', N.STORES],
  ]);
  assert.equal(pi.set_warehouse, undefined);
  assert.deepEqual(gl(pi.name), { [N.STOCK]: 34999.98, [N.COGS]: 350.02, [N.CREDITORS]: -35350 });
  // The lot costs what ERPNext booked into stock, not the planned 10,000.
  assert.deepEqual(shown(r), [['B1', 7.3, 9999.98, 'stores'], ['B2', 12.5, 25000, 'stores']]);
  assert.deepEqual(erp.batchValue('B1-TC', N.STORES), { qty: 7.3, value: 9999.98 });
  assert.equal((await lot('B2')).erpnext_item, N.CUT);
});

test('an invoice sells two lots from where each one is, next to a plain line', async () => {
  const s1 = await h.seedLot(user, client, { code: 'S1', carats: 10, cost: 50000, form: 'cut' });
  const s2 = await h.seedLot(user, client, { code: 'S2', carats: 4, cost: 8000, form: 'cut', location: 'memo', holder: N.CUSTOMER });
  // The lines name S2 first; the operation lists S1 first. Each line finds its own lot.
  const draft = invoice([lotLine('s2', 4, 20000), { description: 'Certificate', qty: 1, rate: 1500 }, lotLine('S1', 2.5, 30000)]);
  const op = h.resolvedOp({ kind: 'sell', counterparty: N.CUSTOMER, inputs: [h.input(s1, { carats: 2.5 }), h.input(s2)] });
  const r = await run(op, draft);
  assert.equal(r.ok, true, r.error);
  const si = erp.get('Sales Invoice', r.docs[0].name);
  assert.equal(si.grand_total, 51500);
  assert.deepEqual(si.items.map((i) => [i.item_code, i.qty, i.rate, i.batch_no || null, i.warehouse || null]), [
    [N.CUT, 4, 5000, 'S2-TC', N.MEMO], ['GEN-SALE', 1, 1500, null, null], [N.CUT, 2.5, 12000, 'S1-TC', N.STORES],
  ]);
  // Cost of sales: all of S2 (8,000) + 2.5 / 10 of S1 (12,500).
  assert.deepEqual(gl(si.name), { [N.DEBTORS]: 51500, [N.SALES]: -51500, [N.COGS]: 20500, [N.STOCK]: -20500 });
  assert.deepEqual(facts(await lot('S1')), ['active', 7.5, 37500, 'stores']);
  assert.deepEqual(facts(await lot('S2')).slice(0, 3), ['closed', 0, 0]);
});

test('VAT on a bill: a registered trader\'s lot costs the net, the bill owes the gross', async () => {
  const registered = await h.addUser({ vat_registered: 1 });
  // 40 ct for 80,000 + 7% VAT 5,600 = 85,600 owed; 80,000 into stock.
  const draft = bill([lotLine('V1', 40, 80000)], { tax_rate: 7, tax_inclusive: false });
  const op = h.resolvedOp({ kind: 'buy', counterparty: N.SUPPLIER, outputs: [h.output({ code: 'V1', carats: 40, cost: 80000, line: 0 })] });
  const r = await run(op, draft, registered);
  assert.equal(r.ok, true, r.error);
  const pi = erp.get('Purchase Invoice', r.docs[0].name);
  assert.equal(pi.grand_total, 85600);
  assert.deepEqual([pi.items[0].qty, pi.items[0].rate], [40, 2000]);
  assert.deepEqual(shown(r), [['V1', 40, 80000, 'stores']]);
  assert.deepEqual(erp.batchValue('V1-TC', N.STORES), { qty: 40, value: 80000 });
});

test('a lot paid on the spot is refused here: it is a bill or an invoice first', async () => {
  const before = erp.calls.length;
  const buy = h.resolvedOp({ kind: 'buy', outputs: [h.output({ code: 'X1', carats: 5, cost: 5000, line: 0 })] });
  let r = await run(buy, bill([lotLine('X1', 5, 5000)], { transaction_type: 'cash' }));
  assert.deepEqual([r.ok, r.partial, r.reference], [false, false, null]);
  assert.match(r.error, /bill_received/);
  const s1 = await lot('S1');
  r = await run(h.resolvedOp({ kind: 'sell', inputs: [h.input(s1, { carats: 1 })] }), invoice([lotLine('S1', 1, 9000)], { transaction_type: 'payment' }));
  assert.deepEqual([r.ok, r.partial], [false, false]);
  assert.match(r.error, /invoice_issued/);
  r = await run(buy, null);
  assert.match(r.error, /bill_received/);
  assert.equal(erp.calls.length, before, 'ERPNext heard nothing');
  assert.deepEqual(await store.unfinishedOps(user.id), []);
});

test('a bill or an invoice whose lines do not match the operation is stopped before anything is posted', async () => {
  const invoices = erp.all('Purchase Invoice').length + erp.all('Sales Invoice').length;
  // The operation says line 1 is the lot; line 1 is shipping.
  const buy = h.resolvedOp({ kind: 'buy', outputs: [h.output({ code: 'X2', carats: 5, cost: 5000, line: 1 })] });
  let r = await run(buy, bill([lotLine('X2', 5, 5000), { description: 'Shipping', qty: 1, rate: 100 }]));
  assert.deepEqual([r.ok, r.partial, r.docs], [false, false, []]);
  assert.match(r.error, /Lot X2 has no line on the bill/);
  assert.equal(await status(r.reference), 'failed');
  assert.equal(await lot('X2'), null);

  // The invoice sells a lot the operation does not take.
  const s1 = await lot('S1');
  r = await run(h.resolvedOp({ kind: 'sell', inputs: [h.input(s1, { carats: 1 })] }), invoice([lotLine('M9', 1, 9000)]));
  assert.deepEqual([r.ok, r.partial, r.docs], [false, false, []]);
  assert.equal(await status(r.reference), 'failed');
  assert.equal(erp.all('Purchase Invoice').length + erp.all('Sales Invoice').length, invoices);
  assert.deepEqual(facts(await lot('S1')), ['active', 7.5, 37500, 'stores']);
  assert.deepEqual(await store.unfinishedOps(user.id), []);
});

// ── stock only ─────────────────────────────────────────────────────────

test('part of a lot goes on memo: one Repack makes the new lot there, at its share of the cost', async () => {
  const m1 = await h.seedLot(user, client, { code: 'M1', carats: 10, cost: 50000, form: 'cut' });
  const op = h.resolvedOp({
    kind: 'move', direction: 'out_memo', holder: N.CUSTOMER,
    inputs: [h.input(m1, { carats: 4 })], outputs: [h.output({ code: 'M2', carats: 4, cost: 20000, to: 'memo', form: 'cut' })],
  });
  const r = await run(op);
  assert.equal(r.ok, true, r.error);
  const se = erp.get('Stock Entry', r.docs[0].name);
  assert.equal(se.stock_entry_type, 'Repack');
  assert.deepEqual(se.items.map((i) => [i.batch_no, i.qty, i.s_warehouse || null, i.t_warehouse || null]), [
    ['M1-TC', 4, N.STORES, null], ['M2-TC', 4, null, N.MEMO],
  ]);
  assert.deepEqual(gl(se.name), {});
  assert.deepEqual(erp.batchValue('M1-TC', N.STORES), { qty: 6, value: 30000 });
  assert.deepEqual(erp.batchValue('M2-TC', N.MEMO), { qty: 4, value: 20000 });
  assert.deepEqual(shown(r), [['M2', 4, 20000, 'memo'], ['M1', 6, 30000, 'stores']]);
});

test('the memo lot comes back whole: a Material Transfer into Stores, same batch', async () => {
  const m2 = await lot('M2');
  const r = await run(h.resolvedOp({
    kind: 'move', direction: 'return', inputs: [h.input(m2)], outputs: [h.output({ lot: m2, carats: 4, cost: 20000, to: 'stores', form: 'cut' })],
  }));
  assert.equal(r.ok, true, r.error);
  const se = erp.get('Stock Entry', r.docs[0].name);
  assert.deepEqual([se.stock_entry_type, se.items[0].s_warehouse, se.items[0].t_warehouse, se.items[0].batch_no], ['Material Transfer', N.MEMO, N.STORES, 'M2-TC']);
  assert.deepEqual(shown(r), [['M2', 4, 20000, 'stores']]);
  assert.equal(posted('Batch') > 0, true);
  assert.equal(marked('Stock Entry', r.reference).length, 1);
});

test('merge: two lots become one new lot worth both', async () => {
  const a = await lot('M1');
  const b = await lot('M2');
  const r = await run(h.resolvedOp({
    kind: 'merge', inputs: [h.input(a), h.input(b)], outputs: [h.output({ code: 'M3', carats: 10, cost: 50000, form: 'cut' })],
  }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(erp.batchValue('M3-TC', N.STORES), { qty: 10, value: 50000 });
  assert.deepEqual(shown(r), [['M3', 10, 50000, 'stores'], ['M1', 0, 0, 'stores'], ['M2', 0, 0, 'stores']]);
});

test('recut: the same lot comes back lighter, in a new batch of its own', async () => {
  const m3 = await lot('M3');
  // 10 ct in, 9.2 ct out, no fee: the lot keeps its cost and takes batch M3-r1-TC.
  const r = await run(h.resolvedOp({
    kind: 'transform', job: 'recut', loss_carats: 0.8, yield_pct: 92,
    inputs: [h.input(m3)], outputs: [h.output({ lot: m3, carats: 9.2, cost: 50000, form: 'cut', revision: 1 })],
  }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.docs.map((d) => d.doctype), ['Stock Entry']);
  assert.equal(r.money_doc, null);
  assert.deepEqual(erp.batchValue('M3-TC', N.STORES), { qty: 0, value: 0 });
  assert.deepEqual(erp.batchValue('M3-r1-TC', N.STORES), { qty: 9.2, value: 50000 });
  const after = await lot('M3');
  assert.deepEqual([...facts(after), after.erpnext_batch, after.revision], ['active', 9.2, 50000, 'stores', 'M3-r1-TC', 1]);
});

test('write-off: stones that are gone leave stock for the Stock Loss account', async () => {
  const w1 = await h.seedLot(user, client, { code: 'W1', carats: 5, cost: 10000 });
  let r = await run(h.resolvedOp({ kind: 'write_off', reason: 'lost in transit', inputs: [h.input(w1, { carats: 2 })] }));
  assert.equal(r.ok, true, r.error);
  const se = erp.get('Stock Entry', r.docs[0].name);
  assert.equal(se.stock_entry_type, 'Material Issue');
  assert.deepEqual(se.items.map((i) => [i.batch_no, i.qty, i.s_warehouse, i.expense_account]), [['W1-TC', 2, N.STORES, STOCK_LOSS]]);
  assert.deepEqual(gl(se.name), { [STOCK_LOSS]: 4000, [N.STOCK]: -4000 }); // 2 / 5 of 10,000
  assert.deepEqual(shown(r), [['W1', 3, 6000, 'stores']]);
  assert.deepEqual(r.saved, { doctype: 'Stock Entry', erpnext_name: se.name });

  r = await run(h.resolvedOp({ kind: 'write_off', reason: 'stolen', inputs: [h.input(await lot('W1'))] }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(facts(await lot('W1')).slice(0, 3), ['closed', 0, 0]);
  assert.deepEqual(erp.batchValue('W1-TC', N.STORES), { qty: 0, value: 0 });
});

test('a fee owed to the cutter is a bill into the holding account, then the Repack', async () => {
  const src = await h.seedLot(user, client, { code: 'F1', carats: 20, cost: 40000 });
  const op = h.resolvedOp({
    kind: 'transform', job: 'heating', inputs: [h.input(src)],
    outputs: [h.output({ lot: src, carats: 20, cost: 41500, revision: 1 })], fee: { amount: 1500, capitalised: 1500, basis: 'fixed' },
  });
  const r = await run(op, fee(1500, { transaction_type: 'bill_received', payment_terms: 'net_30', description: 'Heating F1' }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.docs.map((d) => [d.step, d.doctype]), [[1, 'Purchase Invoice'], [2, 'Stock Entry']]);
  assert.deepEqual(r.money_doc, { doctype: 'Purchase Invoice', erpnext_name: r.docs[0].name });
  const pi = erp.get('Purchase Invoice', r.docs[0].name);
  assert.equal(pi.remarks, lots.remarkFor(r.reference, 1, 2));
  assert.equal(pi.update_stock, 0);
  assert.deepEqual(gl(pi.name), { [N.VALUATION]: 1500, [N.CREDITORS]: -1500 });
  assert.deepEqual(gl(r.docs[1].name), { [N.STOCK]: 1500, [N.VALUATION]: -1500 });
  assert.deepEqual(erp.batchValue('F1-r1-TC', N.STORES), { qty: 20, value: 41500 });
  assert.equal(await balance(N.VALUATION), 0);
  assert.deepEqual(shown(r), [['F1', 20, 41500, 'stores']]);
});

test('a fee that is not the one the operation was worked out with is refused before anything is recorded', async () => {
  const f1 = await lot('F1');
  const plan = { kind: 'transform', job: 'recut', inputs: [h.input(f1)], outputs: [h.output({ lot: f1, carats: 19, cost: 42000, revision: 2 })] };
  const before = erp.calls.length;
  let r = await run(h.resolvedOp({ ...plan, fee: { amount: 500, capitalised: 500, basis: 'fixed' } }), fee(700));
  assert.deepEqual([r.ok, r.partial, r.reference], [false, false, null]);
  assert.match(r.error, /not the fee this operation was worked out with/);
  r = await run(h.resolvedOp({ ...plan, fee: { amount: 500, capitalised: 500, basis: 'fixed' } }), null);
  assert.match(r.error, /no payment or bill/);
  r = await run(h.resolvedOp({ ...plan, fee: { amount: 500, capitalised: 500, basis: 'fixed' } }), fee(500, { transaction_type: 'payment' }));
  assert.match(r.error, /no payment or bill/);
  // Money on an operation that has no fee would never be posted: refused, not dropped.
  r = await run(h.resolvedOp({ kind: 'split', inputs: [h.input(f1)], outputs: [h.output({ code: 'F2', carats: 20, cost: 41500 })] }), fee(500));
  assert.match(r.error, /cannot carry a fee/);
  r = await run({ kind: 'undo' });
  assert.match(r.error, /no stock operation/);
  assert.equal(erp.calls.length, before);
  assert.deepEqual(await store.unfinishedOps(user.id), []);
});

// ── when a step fails ──────────────────────────────────────────────────

test('ERPNext refuses the first document: the operation is failed, nothing is posted, nothing is blocked', async () => {
  const r1 = await h.seedLot(user, client, { code: 'R1', carats: 10, cost: 20000 });
  // Berpal believes 12 ct can be taken; ERPNext holds 10 and refuses the entry.
  const tooMuch = { ...h.input(r1), carats: 12, whole: false };
  const entries = erp.all('Stock Entry').length;
  const r = await run(h.resolvedOp({ kind: 'split', inputs: [tooMuch], outputs: [h.output({ code: 'R2', carats: 12, cost: 20000 })] }));
  assert.deepEqual([r.ok, r.partial, r.docs], [false, false, []]);
  assert.match(r.error, /\[erpnext POST/);
  assert.equal(await status(r.reference), 'failed');
  assert.equal(erp.all('Stock Entry').length, entries);
  assert.deepEqual(facts(await lot('R1')), ['active', 10, 20000, 'stores']);
  assert.equal(await lot('R2'), null);
  assert.deepEqual(await store.unfinishedOps(user.id), []);

  // The next operation runs.
  const ok = await run(h.resolvedOp({ kind: 'split', inputs: [h.input(r1)], outputs: [h.output({ code: 'R2', carats: 4, cost: 8000 }), h.output({ code: 'R3', carats: 6, cost: 12000 })] }));
  assert.equal(ok.ok, true, ok.error);
});

test('ERPNext cannot be reached at all: nothing was sent, so the operation is failed too', async () => {
  const r2 = await lot('R2');
  const op = h.resolvedOp({ kind: 'write_off', reason: 'lost', inputs: [h.input(r2, { carats: 1 })] });
  const r = await withFetch(async () => { throw new Error('connect ECONNREFUSED'); }, () => run(op));
  assert.deepEqual([r.ok, r.partial, r.docs], [false, false, []]);
  assert.match(r.error, /ECONNREFUSED/);
  assert.equal(await status(r.reference), 'failed');
  assert.deepEqual(await store.unfinishedOps(user.id), []);
});

test('the second step is refused: the fee stays posted, the operation is partial and blocks; a retry posts only what is missing', async () => {
  const p1 = await h.seedLot(user, client, { code: 'P1', carats: 30, cost: 60000 });
  const op = h.resolvedOp({
    kind: 'transform', job: 'cutting', inputs: [h.input(p1)],
    outputs: [h.output({ code: 'P2', carats: 9, cost: 60800, form: 'cut' })], fee: { amount: 800, capitalised: 800, basis: 'fixed' },
  });
  const draft = { ...fee(800), confirmation_pending: 'sig', confirmation_sig: 'sig', wallet_options: [1] };
  const r = await withFetch(
    (real, url, opts) => (creates('Stock Entry', url, opts) ? answer(417, 'ValidationError: the period is closed') : real(url, opts)),
    () => run(op, draft)
  );
  assert.deepEqual([r.ok, r.partial], [false, true]);
  assert.match(r.error, /the period is closed/);
  assert.deepEqual(r.docs.map((d) => [d.step, d.doctype]), [[1, 'Journal Entry']]);
  assert.equal(await status(r.reference), 'partial');
  assert.equal((await store.getOp(user.id, r.reference)).error.includes('the period is closed'), true);
  assert.deepEqual(facts(await lot('P1')), ['active', 30, 60000, 'stores'], 'the lots wait for the last document');
  assert.equal(await balance(N.VALUATION), 800, 'the fee waits in the holding account');
  ids.partial = r.reference;

  // Everything else waits for it.
  const other = await run(h.resolvedOp({ kind: 'write_off', inputs: [h.input(await lot('R3'), { carats: 1 })] }));
  assert.deepEqual([other.ok, other.partial, other.reference], [false, false, null]);
  assert.match(other.error, new RegExp(`${r.reference} is not finished yet`));

  // Retry: the STORED plan runs, whatever is handed in; the fee is not paid twice.
  const journals = posted('Journal Entry');
  const again = await execute.run(user, client, { reference: r.reference, op: h.resolvedOp({ kind: 'write_off' }), draft: fee(99999) });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.reference, r.reference);
  assert.deepEqual(again.docs.map((d) => [d.step, d.doctype]), [[1, 'Journal Entry'], [2, 'Stock Entry']]);
  assert.equal(again.docs[0].name, r.docs[0].name);
  assert.equal(posted('Journal Entry'), journals);
  assert.equal(marked('Journal Entry', r.reference).length, 1);
  assert.equal(marked('Stock Entry', r.reference).length, 1);
  assert.deepEqual(shown(again), [['P2', 9, 60800, 'stores'], ['P1', 0, 0, 'stores']]);
  assert.equal(await balance(N.VALUATION), 0);
  assert.equal(await status(r.reference), 'posted');
  // The stored draft carries no card state.
  const kept = (await store.getOp(user.id, r.reference)).plan.draft;
  assert.deepEqual([kept.amount, kept.confirmation_pending, kept.confirmation_sig, kept.wallet_options], [800, undefined, undefined, undefined]);
});

test('retrying a finished operation posts nothing and shows the lots as they stand', async () => {
  const calls = erp.calls.length;
  const r = await execute.run(user, client, { reference: ids.partial });
  assert.equal(r.ok, true);
  assert.deepEqual(shown(r), [['P2', 9, 60800, 'stores'], ['P1', 0, 0, 'stores']]);
  assert.deepEqual(r.docs.map((d) => d.doctype), ['Journal Entry', 'Stock Entry']);
  assert.equal(r.money_doc.doctype, 'Journal Entry');
  assert.equal(erp.calls.length, calls);

  const unknown = await execute.run(user, client, { reference: 'NOPE-1' });
  assert.deepEqual([unknown.ok, unknown.partial], [false, false]);
  assert.match(unknown.error, /not found/);
});

test('no answer after ERPNext accepted the document: partial; the retry finds it by its remark and does not post twice', async () => {
  const t1 = await h.seedLot(user, client, { code: 'T1', carats: 12, cost: 24000 });
  const op = h.resolvedOp({ kind: 'split', inputs: [h.input(t1)], outputs: [h.output({ code: 'T2', carats: 5, cost: 10000 }), h.output({ code: 'T3', carats: 7, cost: 14000 })] });
  const r = await withFetch(async (real, url, opts) => {
    const res = await real(url, opts);
    if (creates('Stock Entry', url, opts)) throw new Error('The operation was aborted due to timeout');
    return res;
  }, () => run(op));
  assert.deepEqual([r.ok, r.partial, r.docs], [false, true, []]);
  assert.match(r.error, /timeout/);
  assert.equal(await status(r.reference), 'partial');
  assert.equal(marked('Stock Entry', r.reference).length, 1, 'ERPNext has it');
  assert.deepEqual(facts(await lot('T1')), ['active', 12, 24000, 'stores'], 'Berpal does not know yet');

  const entries = posted('Stock Entry');
  const again = await execute.run(user, client, { reference: r.reference });
  assert.equal(again.ok, true, again.error);
  assert.equal(posted('Stock Entry'), entries, 'not posted again');
  assert.equal(again.docs[0].name, marked('Stock Entry', r.reference)[0].name);
  assert.deepEqual(shown(again), [['T2', 5, 10000, 'stores'], ['T3', 7, 14000, 'stores'], ['T1', 0, 0, 'stores']]);
  assert.deepEqual(erp.batchValue('T2-TC', N.STORES), { qty: 5, value: 10000 });
});

test('no answer and ERPNext never got it, or a 5xx: partial all the same; the retry posts it once', async () => {
  const t2 = await lot('T2');
  const op = h.resolvedOp({ kind: 'move', direction: 'out_work', holder: N.CUTTER, inputs: [h.input(t2)], outputs: [h.output({ lot: t2, carats: 5, cost: 10000, to: 'work' })] });
  const r = await withFetch(
    (real, url, opts) => (creates('Stock Entry', url, opts) ? Promise.reject(new Error('fetch failed')) : real(url, opts)),
    () => run(op)
  );
  assert.deepEqual([r.ok, r.partial, r.docs], [false, true, []]);
  assert.equal(await status(r.reference), 'partial');
  assert.equal(marked('Stock Entry', r.reference).length, 0);

  // The retry meets a gateway error: still not known, still partial.
  const down = await withFetch(
    (real, url, opts) => (creates('Stock Entry', url, opts) ? answer(502, 'Bad Gateway') : real(url, opts)),
    () => execute.run(user, client, { reference: r.reference })
  );
  assert.deepEqual([down.ok, down.partial, down.reference], [false, true, r.reference]);
  assert.equal(await status(r.reference), 'partial');

  // A retry that cannot even look for the document may not close the operation either.
  const blind = await withFetch(async () => { throw new Error('fetch failed'); }, () => execute.run(user, client, { reference: r.reference }));
  assert.deepEqual([blind.ok, blind.partial], [false, true]);
  assert.equal(await status(r.reference), 'partial');

  const again = await execute.run(user, client, { reference: r.reference });
  assert.equal(again.ok, true, again.error);
  assert.equal(marked('Stock Entry', r.reference).length, 1);
  assert.deepEqual(shown(again), [['T2', 5, 10000, 'work']]);
});

test('a retry that ERPNext clearly refuses, with nothing posted, closes the operation', async () => {
  const t3 = await lot('T3');
  const op = h.resolvedOp({ kind: 'write_off', reason: 'broken', inputs: [h.input(t3, { carats: 2 })] });
  const r = await withFetch(
    (real, url, opts) => (creates('Stock Entry', url, opts) ? Promise.reject(new Error('fetch failed')) : real(url, opts)),
    () => run(op)
  );
  assert.deepEqual([r.ok, r.partial], [false, true]);
  const again = await withFetch(
    (real, url, opts) => (creates('Stock Entry', url, opts) ? answer(417, 'ValidationError: no') : real(url, opts)),
    () => execute.run(user, client, { reference: r.reference })
  );
  assert.deepEqual([again.ok, again.partial, again.docs], [false, false, []]);
  assert.equal(await status(r.reference), 'failed');
  assert.deepEqual(await store.unfinishedOps(user.id), []);
  assert.deepEqual(facts(await lot('T3')), ['active', 7, 14000, 'stores']);
});

test('every document is posted but the stock ledger cannot be read: partial, and the retry only finishes the bookkeeping', async () => {
  const t3 = await lot('T3');
  const op = h.resolvedOp({ kind: 'write_off', reason: 'broken', inputs: [h.input(t3, { carats: 2 })] });
  const r = await withFetch(
    (real, url, opts) => (decodeURIComponent(url).includes('/api/resource/Stock Ledger Entry') ? answer(503, 'busy') : real(url, opts)),
    () => run(op)
  );
  assert.deepEqual([r.ok, r.partial], [false, true]);
  assert.deepEqual(r.docs.map((d) => d.doctype), ['Stock Entry']);
  assert.deepEqual(facts(await lot('T3')), ['active', 7, 14000, 'stores']);
  const entries = posted('Stock Entry');
  const again = await execute.run(user, client, { reference: r.reference });
  assert.equal(again.ok, true, again.error);
  assert.equal(posted('Stock Entry'), entries);
  assert.deepEqual(shown(again), [['T3', 5, 10000, 'stores']]); // 2 / 7 of 14,000 = 4,000 left the lot
});

test('an operation that is being undone, or was failed, cannot be continued', async () => {
  const t3 = await lot('T3');
  const begun = await store.beginOp(user, { op: h.resolvedOp({ kind: 'write_off', inputs: [h.input(t3, { carats: 1 })] }) });
  await store.markUndoing(begun.id);
  const calls = erp.calls.length;
  let r = await execute.run(user, client, { reference: begun.reference });
  assert.deepEqual([r.ok, r.partial], [false, true]);
  assert.match(r.error, /is undoing/);
  await db.query("UPDATE lot_ops SET status = 'failed' WHERE id = $1", [begun.id]);
  r = await execute.run(user, client, { reference: begun.reference });
  assert.deepEqual([r.ok, r.partial], [false, false]);
  assert.match(r.error, /is failed/);
  assert.equal(erp.calls.length, calls);
});

test('the books still balance and stock in hand is what the batches hold', async () => {
  const entries = erp.all('GL Entry').filter((g) => !g.is_cancelled);
  const net = Math.round(entries.reduce((s, g) => s + g.debit - g.credit, 0) * 100) / 100;
  assert.equal(net, 0);
  assert.equal(await balance(N.VALUATION), 0);
  // Every active lot of this user is in ERPNext with the same carats and value.
  for (const l of await store.listLots(user.id, { limit: 200 })) {
    assert.deepEqual(erp.batchValue(l.erpnext_batch, h.WAREHOUSE[l.location]), { qty: l.carats, value: l.cost }, l.code);
  }
});
