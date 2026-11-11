/**
 * Draft → ResolvedOp (src/lots/resolve.js): what one confirmation will do to the lots, every
 * refusal, and that the card and the save agree. The drafts here are as draft.prepare leaves
 * them. A resolved op is applied with h.recordPosted (the store, not ERPNext), so the next
 * resolve sees its result. Tests share state and run in order.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const lots = require('../src/lots');
const store = require('../src/lots/store');
const { resolveDraft } = require('../src/lots/resolve');

const erp = new FakeErpNext();
const { TODAY, WORKED, N } = h;
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

let user; // shares cost by value (the default)
let byWeight;
let other;
let client;

const lot = (code, u = user) => store.getLot(u.id, code);
const stockOp = (sop, extra = {}) => ({ ...extra, stock_op: { date: TODAY, ...sop } });
const bill = (items, extra = {}) => ({
  transaction_type: 'bill_received', direction: 'expense', transaction_date: TODAY, currency: 'THB', counterparty_name: N.SUPPLIER,
  items: items.map(({ rate, description = 'stones', ...l }) => ({ description, qty: 1, rate, lot: l })), ...extra,
});
const invoice = (items, extra = {}) => bill(items, { transaction_type: 'invoice_issued', direction: 'income', counterparty_name: N.CUSTOMER, ...extra });

/** The op a draft resolves to; fails the test with the refusal when there is one. */
async function resolved(draft, opts, u = user) {
  const r = await resolveDraft(u, draft, opts);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(JSON.parse(JSON.stringify(r.op)), r.op, 'the op is JSON-safe');
  return r.op;
}
/** The refusal a draft gets. */
async function refused(draft, opts, u = user) {
  const r = await resolveDraft(u, draft, opts);
  assert.equal(r.ok, false, 'expected a refusal');
  assert.equal(typeof r.error, 'string');
  return r.error;
}
/** What the gate does between the card and the save: the assigned codes go into the draft. */
function writeCodes(draft, op) {
  const next = JSON.parse(JSON.stringify(draft));
  for (const out of op.outputs) {
    if (out.line == null) continue;
    const target = next.stock_op ? next.stock_op.outputs && next.stock_op.outputs[out.line] : next.items[out.line] && next.items[out.line].lot;
    if (target && !target.code) target.code = out.code;
  }
  return next;
}
/** Card, card again, then the save with the codes written back: one and the same op. */
async function stable(draft, opts, u = user) {
  const first = await resolved(draft, opts, u);
  const again = await resolved(draft, opts, u);
  assert.deepEqual(again, first);
  assert.equal(lots.opSignature(again), lots.opSignature(first));
  const atSave = await resolved(writeCodes(draft, first), opts, u);
  assert.equal(lots.opSignature(atSave), lots.opSignature(first), 'the save resolves to what the card showed');
  assert.deepEqual(atSave.outputs, first.outputs);
  return first;
}
const apply = (op, u = user) => h.recordPosted(u, op);
const brief = (o) => [o.code, o.new, o.carats, o.pieces, o.cost, o.to, o.item_kind, o.revision];

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
  byWeight = await h.addUser({ method: 'weight' });
  other = await h.addUser();
});

// ── the worked example of the design (section 6), to the satang ───────

test('worked example: L12 is bought', async () => {
  const draft = bill([{ code: 'L12', carats: 200, form: 'rough', price: 1500, pricing_basis: 'per_ct', species: 'ruby', origin: 'Mogok', rate: 300000, description: 'Mogok ruby rough' }]);
  const op = await stable(draft);
  assert.deepEqual([op.kind, op.date, op.method, op.counterparty, op.fee, op.inputs], ['buy', TODAY, 'value', N.SUPPLIER, null, []]);
  assert.deepEqual(op.outputs, [{
    code: 'L12', new: true, lot_id: null, carats: 200, pieces: null, damaged_pieces: 0, cost: 300000, to: 'stores', item_kind: 'rough',
    revision: 0, weight_estimated: false, line: 0,
    attrs: { form: 'rough', species: 'ruby', origin: 'Mogok', pricing_basis: 'per_ct', description: 'Mogok ruby rough', purchase_unit: 'ct', supplier: N.SUPPLIER },
  }]);
  assert.deepEqual(op.warnings, []);
  await apply(op);
  const l12 = await lot('L12');
  assert.deepEqual([l12.carats, l12.cost, l12.location, l12.species, l12.supplier], [200, 300000, 'stores', 'ruby', N.SUPPLIER]);
});

test('worked example: L12 is split by value into L13 and L14', async () => {
  const l12 = await lot('L12');
  const draft = stockOp({ kind: 'split', inputs: [{ lot: 'L12' }], outputs: [{ carats: 120, value_per_ct: 3000, grade: 'A' }, { carats: 80, value_per_ct: 500 }] });
  const op = await stable(draft);
  assert.deepEqual([op.kind, op.method, op.loss_carats, op.fee, op.yield_pct], ['split', 'value', 0, null, null]);
  assert.deepEqual(op.inputs, [h.input(l12)]);
  assert.equal(op.inputs[0].whole, true);
  assert.deepEqual(op.outputs.map(brief), [
    ['L13', true, 120, null, WORKED.split1[0].cost, 'stores', 'rough', 0],
    ['L14', true, 80, null, WORKED.split1[1].cost, 'stores', 'rough', 0],
  ]);
  assert.deepEqual(op.outputs.map((o) => o.line), [0, 1]);
  // Attributes carry over from L12; what the line says goes on top.
  assert.deepEqual(op.outputs[0].attrs, { ...op.outputs[1].attrs, grade: 'A' });
  assert.deepEqual([op.outputs[1].attrs.species, op.outputs[1].attrs.origin, op.outputs[1].attrs.supplier], ['ruby', 'Mogok', N.SUPPLIER]);
  await apply(op);
  assert.equal((await lot('L12')).status, 'closed');
});

test('worked example: L13 is cut, the fee of 2,400 goes into the stones', async () => {
  const draft = stockOp(
    { kind: 'transform', job: 'cutting', inputs: [{ lot: 'L13' }], outputs: [{ carats: 30, pieces: 42 }], fee_basis: 'per_ct' },
    { transaction_type: 'bill_received', direction: 'expense', amount: 2400, currency: 'THB', counterparty_name: N.CUTTER }
  );
  const op = await stable(draft, { feeCapitalised: WORKED.cut.fee });
  assert.deepEqual([op.kind, op.job, op.yield_pct, op.loss_carats, op.holder], ['transform', 'cutting', WORKED.cut.yield_pct, 90, N.CUTTER]);
  assert.deepEqual(op.fee, { amount: 2400, capitalised: 2400, basis: 'per_ct' });
  assert.deepEqual(op.outputs.map(brief), [['L15', true, 30, 42, WORKED.cut.cost, 'stores', 'cut', 0]]);
  assert.equal(op.outputs[0].attrs.form, 'cut');
  assert.equal(op.outputs[0].attrs.species, 'ruby');
  assert.equal(op.outputs[0].attrs.grade, undefined, 'the grade of the rough says nothing about the cut stones');
  assert.equal(op.outputs[0].attrs.description, undefined);
  assert.deepEqual(op.warnings, []);
  // The part of the fee that is not capitalised stays out of the stones.
  const part = await resolved(draft, { feeCapitalised: 1000 });
  assert.deepEqual([part.fee, part.outputs[0].cost], [{ amount: 2400, capitalised: 1000, basis: 'per_ct' }, 271000]);
  assert.notEqual(lots.opSignature(part), lots.opSignature(op));
  await apply(op);
  assert.deepEqual([(await lot('L15')).pieces, (await lot('L15')).form, (await lot('L15')).erpnext_item], [42, 'cut', N.CUT]);
});

test('worked example: L15 is split by value into L16 and L17', async () => {
  const draft = stockOp({ kind: 'split', inputs: [{ lot: 'L15' }], outputs: [{ carats: 8, pieces: 10, value_per_ct: 25000 }, { carats: 22, pieces: 32, value_per_ct: 5000 }] });
  const op = await stable(draft);
  assert.deepEqual(op.outputs.map(brief), [
    ['L16', true, 8, 10, WORKED.split2[0].cost, 'stores', 'cut', 0],
    ['L17', true, 22, 32, WORKED.split2[1].cost, 'stores', 'cut', 0],
  ]);
  assert.equal(op.inputs[0].pieces, 42);
  assert.equal(Math.round((op.outputs[0].cost + op.outputs[1].cost) * 100), Math.round(WORKED.cut.cost * 100));
  await apply(op);
});

test('worked example: L16 goes out on memo, and 5.5 ct of it is sold from there', async () => {
  const out = await stable(stockOp({ kind: 'move', direction: 'out_memo', inputs: [{ lot: 'L16' }], holder: N.CUSTOMER, due_date: day(14), memo_price_per_ct: 30000 }));
  assert.deepEqual([out.kind, out.direction, out.holder, out.due_date, out.memo_price_per_ct], ['move', 'out_memo', N.CUSTOMER, day(14), 30000]);
  assert.deepEqual(out.outputs.map(brief), [['L16', false, 8, 10, WORKED.split2[0].cost, 'memo', 'cut', 0]]);
  assert.deepEqual([out.outputs[0].lot_id, out.outputs[0].line, out.outputs[0].attrs], [(await lot('L16')).id, null, {}]);
  await apply(out);
  const l16 = await lot('L16');
  assert.deepEqual([l16.location, l16.holder], ['memo', N.CUSTOMER]);

  const draft = invoice([{ code: 'L16', carats: WORKED.sale.carats, price: 30000, pricing_basis: 'per_ct', rate: 165000 }]);
  const op = await stable(draft);
  assert.deepEqual([op.kind, op.counterparty, op.outputs], ['sell', N.CUSTOMER, []]);
  assert.deepEqual(op.inputs, [{ ...h.input(l16, { carats: 5.5 }), cost: WORKED.sale.cogs }]);
  assert.deepEqual([op.inputs[0].from, op.inputs[0].whole, op.inputs[0].item, op.inputs[0].batch], ['memo', false, N.CUT, 'L16-TC']);
  assert.match(op.warnings[0], /pieces taken from lot L16 were not counted/);
  await apply(op);
  const left = await lot('L16');
  assert.deepEqual([left.carats, left.cost, left.status, left.location], [WORKED.sale.left_carats, WORKED.sale.left_cost, 'active', 'memo']);
});

// ── cost methods, isolation, change in between ────────────────────────

test('by weight: the same split and cut share cost by carats, values ignored', async () => {
  await h.seedLot(byWeight, client, { code: 'L12', carats: 200, cost: 300000 });
  const split = await stable(stockOp({ kind: 'split', inputs: [{ lot: 'L12' }], outputs: [{ carats: 120, value_per_ct: 3000 }, { carats: 80 }] }), {}, byWeight);
  assert.equal(split.method, 'weight');
  assert.deepEqual(split.outputs.map(brief), [['L13', true, 120, null, 180000, 'stores', 'rough', 0], ['L14', true, 80, null, 120000, 'stores', 'rough', 0]]);
  await apply(split, byWeight);
  const cut = await stable(stockOp({ kind: 'transform', job: 'cutting', inputs: [{ lot: 'L13' }], outputs: [{ carats: 20 }, { carats: 10, form: 'cabochon' }] }), {}, byWeight);
  assert.deepEqual(cut.outputs.map(brief), [['L15', true, 20, null, 120000, 'stores', 'cut', 0], ['L16', true, 10, null, 60000, 'stores', 'cut', 0]]);
  assert.deepEqual([cut.fee, cut.outputs[1].attrs.form], [null, 'cabochon']);
});

test('by value: outputs without a value are refused, with what to ask', async () => {
  await h.seedLot(user, client, { code: 'L30', carats: 50, cost: 50000, pieces: 20 });
  const error = await refused(stockOp({ kind: 'split', inputs: [{ lot: 'L30' }], outputs: [{ code: 'L31', carats: 30, pieces: 12, value: 40000 }, { carats: 20, pieces: 8 }] }));
  assert.match(error, /shares cost by value, and no value was given for part 2 \(20 ct\)/);
  assert.match(error, /Ask the trader what each part is worth/);
});

test('owner isolation: another user cannot touch, sell or even name the lot', async () => {
  const unknown = /^Lot L30 is not on record for this account\./;
  assert.match(await refused(stockOp({ kind: 'write_off', inputs: [{ lot: 'L30' }], reason: 'lost' }), {}, other), unknown);
  assert.match(await refused(stockOp({ kind: 'move', direction: 'out_work', inputs: [{ lot: 'L30' }], holder: N.CUTTER }), {}, other), unknown);
  assert.match(await refused(invoice([{ code: 'L30', carats: 1, price: 1, pricing_basis: 'total', rate: 1 }]), {}, other), unknown);
  // Codes are per user: the other user may buy their own L30 and gets their own numbering.
  const op = await resolved(bill([{ code: 'L30', carats: 5, form: 'cut', price: 100, pricing_basis: 'total', rate: 100 }, { carats: 1, form: 'cut', price: 5, pricing_basis: 'total', rate: 5 }]), {}, other);
  assert.deepEqual(op.outputs.map((o) => o.code), ['L30', 'L31']);
  assert.equal((await lot('L30')).carats, 50, 'nothing was written');
});

test('a lot that changed between the card and the save gives another signature', async () => {
  const draft = stockOp({ kind: 'write_off', inputs: [{ lot: 'L30', carats: 1, pieces: 1 }], reason: 'chipped' });
  const card = await stable(draft);
  assert.deepEqual([card.kind, card.reason, card.loss_carats, card.outputs], ['write_off', 'chipped', 1, []]);
  assert.deepEqual([card.inputs[0].carats, card.inputs[0].pieces, card.inputs[0].cost, card.inputs[0].whole], [1, 1, 1000, false]);
  await apply(await resolved(stockOp({ kind: 'write_off', inputs: [{ lot: 'L30', carats: 10, pieces: 4 }], reason: 'lost' })));
  const save = await resolved(draft);
  assert.deepEqual(save.inputs[0].before, { ...card.inputs[0].before, carats: 40, pieces: 16, cost: 40000 });
  assert.notEqual(lots.opSignature(save), lots.opSignature(card));
});

// ── buying ────────────────────────────────────────────────────────────

test('buy: what goes into stock follows the VAT treatment and the currency', async () => {
  const line = { carats: 10, pieces: 4, form: 'cut', price: 1000, pricing_basis: 'total', rate: 1000 };
  // Not VAT registered: the VAT cannot be claimed back, so it is part of the cost.
  assert.equal((await resolved(bill([line], { tax_rate: 7 }))).outputs[0].cost, 1070);
  assert.equal((await resolved(bill([line], { tax_rate: 7, tax_inclusive: true }))).outputs[0].cost, 1000);
  assert.equal((await resolved(bill([line]))).outputs[0].cost, 1000);
  const registered = await h.addUser({ vat_registered: 1 });
  assert.equal((await resolved(bill([line], { tax_rate: 7 }), {}, registered)).outputs[0].cost, 1000);
  assert.equal((await resolved(bill([line], { tax_rate: 7, tax_inclusive: true }), {}, registered)).outputs[0].cost, 934.58);
  assert.equal((await resolved(bill([line], { tax_rate: 7, vat_claimable: false }), {}, registered)).outputs[0].cost, 1070);
  // Two lines: each takes its own share, and the shares sum to the bill.
  const two = await resolved(bill([{ ...line, rate: 100 }, { ...line, rate: 200.01 }], { tax_rate: 7, tax_inclusive: true }), {}, registered);
  assert.deepEqual(two.outputs.map((o) => o.cost), [93.46, 186.92]);
  assert.deepEqual(two.outputs.map((o) => [o.code, o.line, o.pieces, o.item_kind]), [['L1', 0, 4, 'cut'], ['L2', 1, 4, 'cut']]);
  // A foreign bill goes into stock in the company's currency.
  assert.equal((await resolved(bill([line], { currency: 'USD', exchange_rate: 35.5 }))).outputs[0].cost, 35500);
  assert.match(await refused(bill([line], { currency: 'USD' })), /no exchange rate for USD→THB; call fetch_exchange_rate first/);
});

test('buy: the supplier on record, an estimated weight, and what the line says about the stones', async () => {
  const counterparties = require('../src/counterparties');
  const party = await counterparties.upsert(user, { name: 'Chanthaburi Gems Ltd' });
  const draft = bill([{
    carats: 12.3456, form: 'rough', price: 80, pricing_basis: 'per_g', rate: 197.53, weight_estimated: true, supplier_doc: false, vat_exempt: 'true',
    species: ' sapphire ', treatment: 'unknown', treatment_source: 'supplier', description: 'blue rough',
  }], { counterparty_id: party.id, counterparty_name: 'someone else' });
  const op = await stable(draft);
  const [next] = await store.nextCodes(user.id, 1);
  assert.equal(op.counterparty, 'Chanthaburi Gems Ltd');
  assert.deepEqual([op.outputs[0].code, op.outputs[0].carats, op.outputs[0].weight_estimated], [next, 12.346, true]);
  assert.deepEqual(op.outputs[0].attrs, {
    form: 'rough', species: 'sapphire', treatment: 'unknown', treatment_source: 'supplier', pricing_basis: 'per_g', description: 'blue rough',
    purchase_unit: 'g', supplier: 'Chanthaburi Gems Ltd', supplier_doc: false, vat_exempt: true,
  });
  assert.deepEqual(op.warnings, [`The weight of lot ${next} is an estimate. Re-weigh it when you can, so its cost per carat is right.`]);
});

test('buy: refusals', async () => {
  const line = { carats: 10, form: 'cut', price: 1000, pricing_basis: 'total', rate: 1000 };
  assert.match(await refused(bill([{ ...line, code: 'L14' }])), /^Lot L14 already exists, so it cannot be the code of a new lot\./);
  assert.match(await refused(bill([{ ...line, code: 'L12' }])), /^Lot L12 already exists/, 'a closed lot keeps its code');
  assert.match(await refused(bill([{ ...line, code: 'l90' }, { ...line, code: 'L90' }])), /^Lot L90 is given to two lines\./);
  assert.match(await refused(bill([{ ...line, code: '???' }])), /^items\[0\]\.lot\.code "\?\?\?" cannot be a lot code/);
  assert.match(await refused(bill([{ ...line, carats: 0 }])), /^items\[0\]\.lot needs the weight in carats/);
  assert.match(await refused(bill([line, { ...line, rate: 0 }])), /^items\[1\]\.lot has no price/);
  assert.match(await refused(bill([{ ...line, form: 'pebble' }])), /^items\[0\]\.lot needs form \(rough, preform, cut, cabochon, bead\)/);
  assert.match(await refused(bill([line], { transaction_date: day(2) })), new RegExp(`^The date ${day(2)} is in the future\\.`));
  assert.match(await refused(bill([line], { transaction_date: 'yesterday' })), /^The date "yesterday" is not a date\./);
  assert.match(await refused(bill([line], { transaction_type: 'payment_made' })), /^Lots are bought on a bill and sold on an invoice\./);
  // A purchase may be dated in the past: there is no lot yet whose history it could cut into.
  assert.equal((await resolved(bill([line], { transaction_date: day(-30) }))).date, day(-30));
});

// ── selling ───────────────────────────────────────────────────────────

test('sell: the whole lot, a part, and every refusal', async () => {
  const sale = (l, extra) => invoice([{ price: 1, pricing_basis: 'total', rate: 1, ...l }], extra);
  const l17 = await lot('L17');
  const whole = await stable(sale({ code: 'L17', carats: 22 }));
  assert.deepEqual(whole.inputs, [h.input(l17)]);
  assert.deepEqual([whole.inputs[0].whole, whole.inputs[0].pieces, whole.inputs[0].cost], [true, 32, WORKED.split2[1].cost]);
  const part = await resolved(sale({ code: 'L17', carats: 2, pieces: 3 }));
  assert.deepEqual([part.inputs[0].whole, part.inputs[0].pieces, part.inputs[0].cost, part.warnings], [false, 3, 8787.1, []]);

  assert.match(await refused(sale({ carats: 2 })), /^items\[0\]\.lot needs the code of the lot being sold/);
  assert.match(await refused(sale({ code: 'L999', carats: 2 })), /^Lot L999 is not on record for this account\./);
  assert.equal(await refused(sale({ code: 'L17', carats: 25 })), 'Lot L17 holds 22 ct; you cannot take 25 ct from it. Ask the trader to check the weight.');
  assert.match(await refused(sale({ code: 'L12', carats: 1 })), /^Lot L12 is empty: nothing is left in it\./);
  assert.match(await refused(sale({ code: 'L17', carats: 0 })), /^The weight taken from lot L17 must be more than 0 ct/);
  assert.match(await refused(sale({ code: 'L17', carats: 2, pieces: 40 })), /^Lot L17 holds 32 pieces; you cannot take 40 from it\./);
  assert.match(await refused(sale({ code: 'L17', carats: 2, pieces: 32 })), /^Taking 32 pieces from lot L17 takes every piece but leaves weight in it\./);
  assert.match(await refused(sale({ code: 'L17', carats: 22, pieces: 30 })), /^Lot L17 holds 32 pieces; taking the whole lot takes all of them, not 30\./);
  assert.match(await refused(invoice([{ code: 'L17', carats: 1, rate: 1 }, { code: 'L17', carats: 2, rate: 1 }])), /^Lot L17 is on two lines\./);
  assert.equal(
    await refused(sale({ code: 'L17', carats: 2 }, { transaction_date: day(-1) })),
    `Lot L17 was last changed on ${TODAY}, and this is dated ${day(-1)}, before that. An operation cannot be dated before the lot's last one: ask the trader for the right date.`
  );
  assert.match(await refused(sale({ code: 'L17', carats: 2 }, { transaction_date: day(2) })), /is in the future/);

  await h.seedLot(user, client, { code: 'L40', carats: 10, cost: 5000, form: 'cut', location: 'work', holder: N.CUTTER });
  assert.equal(
    await refused(sale({ code: 'L40', carats: 2 })),
    'Lot L40 is out for work with Somchai Cutting: it cannot be sold from there. Record its return first (a move with direction return), then the sale.'
  );
});

// ── splitting ─────────────────────────────────────────────────────────

test('split: a part of a lot, a loss within the tolerance, counted pieces', async () => {
  // L30: 40 ct, 16 pieces, 40,000. Taking 10 ct out is a split with one part; its pieces are those of the part.
  const out = await stable(stockOp({ kind: 'split', inputs: [{ lot: 'L30', carats: 10 }], outputs: [{ carats: 10, pieces: 3, damaged_pieces: 1 }] }));
  assert.deepEqual([out.inputs[0].whole, out.inputs[0].carats, out.inputs[0].pieces, out.inputs[0].cost], [false, 10, 4, 10000]);
  assert.deepEqual([out.outputs[0].carats, out.outputs[0].pieces, out.outputs[0].damaged_pieces, out.outputs[0].cost, out.loss_carats], [10, 3, 1, 10000, 0]);
  assert.deepEqual(out.warnings, []);
  // A part taken and parts not counted: the count left in the lot is no longer known.
  const uncounted = await resolved(stockOp({ kind: 'split', inputs: [{ lot: 'L30', carats: 10 }], outputs: [{ carats: 6, value: 1 }, { carats: 4, value: 1 }] }));
  assert.deepEqual([uncounted.inputs[0].pieces, uncounted.outputs.map((o) => o.pieces)], [null, [null, null]]);
  assert.match(uncounted.warnings[0], /pieces taken from lot L30 were not counted/);
  // The whole lot, 0.15 ct short (40 ct may differ by 0.2 ct): a loss, and the card says so.
  const whole = await stable(stockOp({ kind: 'split', inputs: [{ lot: 'L30' }], outputs: [{ carats: 25, pieces: 10, value: 30000 }, { carats: 14.85, pieces: 6, value: 10000, treatment: 'H' }] }));
  assert.deepEqual([whole.loss_carats, whole.warnings], [0.15, ['0.15 ct is lost (40 ct in, 39.85 ct out).']]);
  assert.deepEqual(whole.outputs.map((o) => [o.cost, o.attrs.treatment]), [[30000, undefined], [10000, 'H']]);
  const over = await resolved(stockOp({ kind: 'split', inputs: [{ lot: 'L30' }], outputs: [{ carats: 25, pieces: 10, value: 1 }, { carats: 15.1, pieces: 6, value: 1 }] }));
  assert.deepEqual([over.loss_carats, over.warnings], [-0.1, ['0.1 ct more comes out than went in (40 ct in, 40.1 ct out).']]);
});

test('split: refusals', async () => {
  const split = (sop, extra) => stockOp({ kind: 'split', inputs: [{ lot: 'L30' }], ...sop }, extra);
  const parts = [{ carats: 25, pieces: 10, value: 1 }, { carats: 15, pieces: 6, value: 1 }];
  assert.match(await refused(split({ inputs: [{ lot: 'L30' }, { lot: 'L14' }], outputs: parts })), /^A split works on one lot at a time\./);
  assert.match(await refused(split({ inputs: [], outputs: parts })), /^A split works on one lot at a time\./);
  assert.match(await refused(split({ inputs: [{ lot: 'L404' }], outputs: parts })), /^Lot L404 is not on record for this account\./);
  assert.match(await refused(split({ outputs: [] })), /^A split needs stock_op\.outputs/);
  assert.match(await refused(split({ outputs: [{ carats: 40, pieces: 16 }] })), /^A split of the whole of lot L30 needs at least two parts\./);
  assert.match(await refused(split({ outputs: [{ carats: 25 }, { pieces: 3 }] })), /^stock_op\.outputs\[1\] needs its weight in carats/);
  assert.equal(
    await refused(split({ outputs: [{ carats: 25, pieces: 10, value: 1 }, { carats: 10, pieces: 6, value: 1 }] })),
    'The parts weigh 35 ct, but 40 ct of lot L30 go in: 5 ct short, and the weights may differ by 0.2 ct at most. '
      + 'Ask the trader to check the weights (to take only part of the lot, give carats on the input).'
  );
  assert.match(await refused(split({ outputs: [{ carats: 25, pieces: 10, value: 1 }, { carats: 15.3, pieces: 6, value: 1 }] })), /0\.3 ct over, and the weights may differ by 0\.2 ct at most/);
  assert.match(await refused(split({ inputs: [{ lot: 'L30', carats: 50 }], outputs: parts })), /^Lot L30 holds 40 ct; you cannot take 50 ct from it\./);
  assert.equal(
    await refused(split({ outputs: [{ carats: 25, pieces: 10, value: 1 }, { carats: 15, pieces: 5, value: 1 }] })),
    '16 pieces of lot L30 go in, but 15 come out (15 in the parts). Pieces out plus damaged must equal pieces in: ask the trader to count again.'
  );
  assert.match(await refused(split({ outputs: [{ carats: 25, pieces: 10, value: 1 }, { carats: 15, pieces: 5, damaged_pieces: 2, value: 1 }] })), /but 17 come out \(15 in the parts, 2 damaged\)/);
  assert.match(await refused(split({ outputs: [{ carats: 25, pieces: 10, value: 1 }, { carats: 15, value: 1 }] })), /^Lot L30 is counted \(16 pieces go in\): every part needs its pieces\./);
  assert.match(await refused(split({ inputs: [{ lot: 'L30', pieces: 12 }], outputs: parts })), /^Lot L30 holds 16 pieces; taking the whole lot takes all of them, not 12\./);
  assert.match(await refused(split({ outputs: [{ ...parts[0], form: 'cut' }, parts[1]] })), /^A split only sorts stones: part 1 cannot be cut when lot L30 is rough\./);
  assert.match(await refused(split({ outputs: [{ ...parts[0], code: 'L14' }, parts[1]] })), /^Lot L14 already exists, so it cannot be the code of a new lot\./);
  assert.match(await refused(split({ outputs: [{ ...parts[0], code: 'L91' }, { ...parts[1], code: 'L91' }] })), /^Lot L91 is given to two lines\./);
  assert.match(await refused(split({ inputs: [{ lot: 'L40' }], outputs: parts })), /^Lot L40 is out for work with Somchai Cutting\. Record its return first \(a move with direction return\), then split it\./);
  assert.match(await refused(split({ outputs: parts, date: day(-1) })), /^Lot L30 was last changed on /);
  assert.match(await refused(split({ outputs: parts, date: day(2) })), /is in the future/);
  // A fee belongs to a transform only.
  assert.equal(
    await refused(split({ outputs: parts }, { amount: 500 })),
    'Only a transform (cutting, heating, …) carries a fee; a split moves no money. Set amount to 0 and record the cost as its own expense.'
  );
});

// ── merging ───────────────────────────────────────────────────────────

test('merge: several lots into a new one, or into one of them', async () => {
  const l50 = await h.seedLot(user, client, { code: 'L50', carats: 20, cost: 10000, pieces: 5, attrs: { species: 'ruby', origin: 'Mogok', treatment: 'H' } });
  const l51 = await h.seedLot(user, client, { code: 'L51', carats: 30, cost: 6000.5, pieces: 7, attrs: { species: 'ruby', origin: 'Mong Hsu', treatment: 'none' } });
  const merge = (sop) => stockOp({ kind: 'merge', inputs: [{ lot: 'L50' }, { lot: 'L51' }], ...sop });
  const mixed = 'These lots have different treatments (L50: H, L51: none). The merged lot is marked "mixed".';

  // A new lot: what the lots agree on stays, different treatments become "mixed".
  const fresh = await stable(merge({ outputs: [{ carats: 50 }] }));
  const [next] = await store.nextCodes(user.id, 1);
  assert.deepEqual([fresh.kind, fresh.loss_carats, fresh.warnings], ['merge', 0, [mixed]]);
  assert.deepEqual(fresh.inputs, [h.input(l50), h.input(l51)]);
  assert.deepEqual(fresh.outputs, [{
    code: next, new: true, lot_id: null, carats: 50, pieces: 12, damaged_pieces: 0, cost: 16000.5, to: 'stores', item_kind: 'rough',
    revision: 0, weight_estimated: false, line: 0, attrs: { form: 'rough', species: 'ruby', treatment: 'mixed' },
  }]);
  // No output line at all: the weight is the sum, and the code is assigned again at save time.
  const bare = await stable(merge({}));
  assert.deepEqual([bare.outputs[0].code, bare.outputs[0].carats, bare.outputs[0].line], [next, 50, null]);
  // What the trader says about the result wins; a part of a lot may go in.
  const said = await resolved(merge({ inputs: [{ lot: 'L50', carats: 5, pieces: 1 }, { lot: 'L51' }], outputs: [{ code: 'L95', carats: 35, treatment: 'H', grade: 'B' }] }));
  assert.deepEqual([said.outputs[0].code, said.outputs[0].pieces, said.outputs[0].cost, said.warnings], ['L95', 8, 8500.5, []]);
  assert.deepEqual(said.outputs[0].attrs, { form: 'rough', species: 'ruby', treatment: 'H', grade: 'B' });

  // Into L50: the lot is kept under its code, only what changes is written.
  const kept = await stable(merge({ outputs: [{ code: 'L50', carats: 50 }] }));
  assert.deepEqual(kept.outputs, [{
    code: 'L50', new: false, lot_id: l50.id, carats: 50, pieces: 12, damaged_pieces: 0, cost: 16000.5, to: 'stores', item_kind: 'rough',
    revision: 0, weight_estimated: false, line: 0, attrs: { origin: null, treatment: 'mixed' },
  }]);
  assert.deepEqual(kept.warnings, [mixed]);
  await apply(kept);
  const after = await lot('L50');
  assert.deepEqual([after.status, after.carats, after.pieces, after.cost, after.treatment, after.origin, after.species], ['active', 50, 12, 16000.5, 'mixed', null, 'ruby']);
  assert.equal((await lot('L51')).status, 'closed');
});

test('merge: refusals', async () => {
  const merge = (sop, extra) => stockOp({ kind: 'merge', inputs: [{ lot: 'L50' }, { lot: 'L30' }], ...sop }, extra);
  assert.match(await refused(merge({ inputs: [{ lot: 'L50' }] })), /^A merge needs at least two lots in stock_op\.inputs\./);
  assert.match(await refused(merge({ inputs: [{ lot: 'L50' }, { lot: 'l50' }] })), /^Lot L50 is listed twice in stock_op\.inputs\./);
  assert.match(await refused(merge({ inputs: [{ lot: 'L50' }, { lot: 'L51' }] })), /^Lot L51 is empty/);
  assert.match(await refused(merge({ inputs: [{ lot: 'L50' }, { lot: 'L16' }] })), /^Lot L16 is out on memo with Siam Jewels\. Record its return first \(a move with direction return\), then put the lots together\./);
  assert.equal(await refused(merge({ inputs: [{ lot: 'L50' }, { lot: 'L17' }] })), 'Lot L50 is rough and lot L17 is cut: rough and cut stones cannot go into one lot.');
  assert.match(await refused(merge({ outputs: [{ carats: 50 }, { carats: 40 }] })), /^A merge makes one lot: give one output\./);
  assert.match(await refused(merge({ outputs: [{ carats: 80 }] })), /^The merged lot is given as 80 ct, but 90 ct go in: 10 ct short, and the weights may differ by 0\.45 ct at most\./);
  assert.match(await refused(merge({ outputs: [{ carats: 90, pieces: 20 }] })), /^The lots hold 28 pieces together, not 20\./);
  assert.match(await refused(merge({ outputs: [{ carats: 90, form: 'cut' }] })), /^A merge only puts stones together: the result cannot be cut when the lots are rough\./);
  assert.equal(
    await refused(merge({ inputs: [{ lot: 'L50', carats: 10, pieces: 2 }, { lot: 'L30' }], outputs: [{ code: 'L50', carats: 50 }] })),
    'To put the stones into lot L50, all of it goes in: leave carats out on that input, or leave the output code out for a new lot.'
  );
  assert.equal(
    await refused(merge({ outputs: [{ code: 'L14', carats: 90 }] })),
    'Lot L14 already exists, so it cannot be the code of a new lot. Leave the code out and one is assigned, or ask the trader for another code. To add stones to an existing lot, list that lot in inputs too.'
  );
  assert.match(await refused(merge({}, { amount: 100 })), /^Only a transform \(cutting, heating, …\) carries a fee; a merge moves no money\./);
});

// ── transforming ──────────────────────────────────────────────────────

test('transform: a whole-lot recut or re-weigh keeps the lot under a new revision', async () => {
  const l17 = await lot('L17');
  const fee = { transaction_type: 'bill_received', direction: 'expense', amount: 535, currency: 'THB', counterparty_name: N.CUTTER };
  const draft = stockOp({ kind: 'transform', job: 'recut', inputs: [{ lot: 'L17' }], outputs: [{ carats: 20, shape: 'oval' }], fee_basis: 'fixed' }, fee);
  const recut = await stable(draft, { feeCapitalised: 500 });
  assert.deepEqual([recut.job, recut.yield_pct, recut.loss_carats, recut.holder, recut.warnings], ['recut', 90.9, 2, N.CUTTER, []]);
  assert.deepEqual(recut.fee, { amount: 535, capitalised: 500, basis: 'fixed' });
  assert.deepEqual(recut.outputs, [{
    code: 'L17', new: false, lot_id: l17.id, carats: 20, pieces: 32, damaged_pieces: 0, cost: 97158.06, to: 'stores', item_kind: 'cut',
    revision: 1, weight_estimated: false, line: 0, attrs: { shape: 'oval' },
  }]);
  assert.match(await refused(stockOp({ kind: 'transform', job: 'recut', inputs: [{ lot: 'L17' }], outputs: [{ code: 'L96', carats: 20 }] })), /^A recut of the whole lot keeps its code L17\. Remove the code L96 from the output\./);
  // A recut of part of the lot makes a new lot; the stones lose no attribute but their size.
  const part = await resolved(stockOp({ kind: 'transform', job: 'recut', inputs: [{ lot: 'L17', carats: 5, pieces: 6 }], outputs: [{ carats: 4, pieces: 6 }] }));
  assert.deepEqual([part.outputs[0].new, part.outputs[0].revision, part.outputs[0].cost, part.outputs[0].attrs.form, part.fee], [true, 0, 21967.74, 'cut', null]);
  await apply(recut);
  const after = await lot('L17');
  assert.deepEqual([after.carats, after.pieces, after.cost, after.revision, after.erpnext_batch, after.shape], [20, 32, 97158.06, 1, 'L17-r1-TC', 'oval']);

  // A re-weigh may find more than was on record: no tolerance, a negative loss.
  const l14 = await lot('L14');
  const reweigh = await stable(stockOp({ kind: 'transform', job: 'reweigh', inputs: [{ lot: 'L14' }], outputs: [{ carats: 81.25 }] }));
  assert.deepEqual([reweigh.yield_pct, reweigh.loss_carats, reweigh.fee, reweigh.holder, reweigh.warnings], [101.6, -1.25, null, null, []]);
  assert.deepEqual(reweigh.outputs.map(brief), [['L14', false, 81.25, null, 30000, 'stores', 'rough', l14.revision + 1]]);
  assert.deepEqual([reweigh.outputs[0].lot_id, reweigh.outputs[0].attrs], [l14.id, {}]);
  const reweighs = (sop) => refused(stockOp({ kind: 'transform', job: 'reweigh', inputs: [{ lot: 'L14' }], outputs: [{ carats: 81 }], ...sop }));
  assert.match(await reweighs({ inputs: [{ lot: 'L14', carats: 10 }] }), /^A re-weigh corrects the weight of one whole lot/);
  assert.match(await reweighs({ outputs: [{ carats: 40, value: 1 }, { carats: 40, value: 1 }] }), /^A re-weigh corrects the weight of one whole lot/);
  assert.match(await reweighs({ inputs: [{ lot: 'L40' }] }), /^Lot L40 is out for work with Somchai Cutting\. Record its return first \(a move with direction return\), then the re-weigh\./);
  assert.match(await reweighs({ outputs: [{ carats: 81, form: 'cut' }] }), /^A re-weigh does not turn rough stones into cut: output 1 stays rough or preform\. Stones that were cut are job cutting\./);
});

test('transform: heating, cutting from the cutter, several outputs, advisory warnings', async () => {
  // Heating keeps the kind and the count; the new treatment is what the line says.
  const heated = await stable(stockOp({ kind: 'transform', job: 'heating', inputs: [{ lot: 'L30' }], outputs: [{ carats: 39.5, treatment: 'H' }] }));
  assert.deepEqual(heated.outputs.map(brief), [[heated.outputs[0].code, true, 39.5, 16, 40000, 'stores', 'rough', 0]]);
  assert.deepEqual([heated.outputs[0].attrs, heated.loss_carats, heated.warnings], [{ form: 'rough', treatment: 'H' }, 0.5, []]);
  const silent = await resolved(stockOp({ kind: 'transform', job: 'heating', inputs: [{ lot: 'L30' }], outputs: [{ carats: 30 }] }));
  assert.deepEqual(silent.warnings, [
    'Heating lost 25% of the weight (30 ct from 40 ct). More than 15% is unusual. Check the weights.',
    'The treatment on record after this heating is not set. Say what it is now (for example H) so it is on the lot.',
  ]);

  // Rough out with the cutter comes back cut, straight into stores; cut stones and a saleable offcut share the cost.
  const l41 = await h.seedLot(user, client, { code: 'L41', carats: 30, cost: 9000, location: 'work', holder: N.CUTTER, attrs: { species: 'spinel', shape: 'pebble', grade: 'A' } });
  const cut = await stable(stockOp(
    { kind: 'transform', job: 'cutting', inputs: [{ lot: 'L41' }], outputs: [{ carats: 6, pieces: 9, value: 9000, shape: 'cushion' }, { carats: 12, value: 1000, form: 'rough', description: 'offcuts' }] },
    { transaction_type: 'bill_received', direction: 'expense', amount: 1000, currency: 'THB' }
  ), { feeCapitalised: 1000 });
  assert.deepEqual(cut.inputs, [h.input(l41)]);
  assert.deepEqual([cut.inputs[0].from, cut.holder, cut.yield_pct, cut.loss_carats], ['work', N.CUTTER, 60, 12]);
  assert.deepEqual(cut.outputs.map(brief).map((o) => o.slice(1)), [[true, 6, 9, 9000, 'stores', 'cut', 0], [true, 12, null, 1000, 'stores', 'rough', 0]]);
  assert.deepEqual(cut.outputs.map((o) => o.attrs), [{ form: 'cut', species: 'spinel', shape: 'cushion' }, { form: 'rough', species: 'spinel', description: 'offcuts' }]);
  assert.deepEqual(cut.warnings, ['Yield is 60% (18 ct from 30 ct). That is high: over 50% is unusual for cutting. Check the weights.']);
  // Without money on the draft there is no fee, whatever the caller passes.
  const free = await resolved(stockOp({ kind: 'transform', job: 'cutting', inputs: [{ lot: 'L41' }], outputs: [{ carats: 6 }] }), { feeCapitalised: 1000 });
  assert.deepEqual([free.fee, free.outputs[0].cost, free.holder], [null, 9000, N.CUTTER]);

  // Two lots sawn together: what they agree on carries over, and a recut of a fragile treatment is flagged.
  await h.seedLot(user, client, { code: 'L42', carats: 10, cost: 1000, attrs: { species: 'spinel' } });
  await h.seedLot(user, client, { code: 'L43', carats: 10, cost: 3000, attrs: { species: 'spinel', origin: 'Mahenge' } });
  const sawn = await resolved(stockOp({ kind: 'transform', job: 'sawing', inputs: [{ lot: 'L42' }, { lot: 'L43', carats: 5 }], outputs: [{ carats: 14 }] }));
  assert.deepEqual([sawn.outputs[0].cost, sawn.outputs[0].attrs, sawn.outputs[0].item_kind], [2500, { form: 'rough', species: 'spinel' }, 'rough']);
  await h.seedLot(user, client, { code: 'L44', carats: 3, cost: 900, form: 'cut', attrs: { treatment: 'H-GF', size: '7x5' } });
  const fragile = await resolved(stockOp({ kind: 'transform', job: 'recut', inputs: [{ lot: 'L44' }], outputs: [{ carats: 2.8 }] }));
  assert.deepEqual(fragile.warnings, ['Lot L44 is treated (H-GF): a recut can remove or damage that treatment. Check the stones afterwards.']);
  assert.deepEqual(fragile.outputs[0].attrs, { size: null }, 'the old size is no longer true');
});

test('transform: refusals', async () => {
  const work = (job, code, outputs = [{ carats: 1 }], sop = {}) => refused(stockOp({ kind: 'transform', job, inputs: [{ lot: code }], outputs, ...sop }));
  assert.match(await work('polishing', 'L30'), /^A transform needs stock_op\.job: cutting, sawing, heating, preform, recut, reweigh\./);
  assert.match(await work('cutting', 'L30', []), /^A transform needs stock_op\.outputs/);
  assert.match(await work('cutting', 'L30', [{ carats: 0 }]), /^stock_op\.outputs\[0\] needs its weight in carats/);
  assert.match(await work('cutting', 'L404'), /^Lot L404 is not on record for this account\./);
  assert.match(await work('cutting', 'L17'), /^Lot L17 is already cut\. Cutting it again is job recut\./);
  assert.match(await work('recut', 'L30'), /^Lot L30 is rough, not cut: cutting it is job cutting, not recut\./);
  assert.match(await work('preform', 'L17'), /^Lot L17 is already cut: it cannot be preformed\./);
  assert.match(await work('heating', 'L30', [{ carats: 30, form: 'cut' }]), /^A heating does not turn rough stones into cut: output 1 stays rough or preform\./);
  assert.match(await work('heating', 'L16'), /^Lot L16 is out on memo with Siam Jewels\. Record its return first \(a move with direction return\), then the heating\./);
  assert.equal(
    await work('cutting', 'L30', [{ carats: 41 }]),
    '41 ct came out of 40 ct: more than went in. Ask the trader to check the weights. If the weight on record was wrong, correct it first with a re-weigh (job reweigh).'
  );
  assert.match(await work('cutting', 'L30', [{ carats: 5 }, { carats: 5, value: 100 }]), /no value was given for part 1 \(5 ct\)/);
  assert.match(await work('cutting', 'L30', [{ carats: 5, code: 'L14' }]), /^Lot L14 already exists/);
  assert.match(await work('cutting', 'L30', undefined, { inputs: [{ lot: 'L30', carats: 41 }] }), /^Lot L30 holds 40 ct; you cannot take 41 ct from it\./);
  assert.match(await work('sawing', 'L30', undefined, { inputs: [{ lot: 'L30' }, { lot: 'L17' }] }), /^Lot L30 is rough and lot L17 is cut: rough and cut stones are worked on separately\. Record one sawing for each\./);
  assert.match(await work('cutting', 'L30', undefined, { inputs: [] }), /^stock_op\.inputs must list the lot\(s\) this is done to\./);
  assert.match(await work('cutting', 'L30', undefined, { inputs: [{ carats: 3 }] }), /^stock_op\.inputs\[0\] needs the code of a lot\./);
  assert.match(await work('cutting', 'L30', undefined, { date: day(-1) }), /^Lot L30 was last changed on /);
  assert.match(await work('cutting', 'L30', undefined, { date: day(2) }), /is in the future/);
});

// ── moving ────────────────────────────────────────────────────────────

test('move: a whole lot keeps its code, a part becomes a new lot where it goes', async () => {
  const l14 = await lot('L14');
  const out = await stable(stockOp({ kind: 'move', direction: 'out_work', inputs: [{ lot: 'L14' }], holder: ` ${N.CUTTER} `, due_date: TODAY, memo_price_per_ct: 99, note: ' for sawing ' }));
  assert.deepEqual([out.direction, out.holder, out.due_date, out.memo_price_per_ct, out.note, out.loss_carats], ['out_work', N.CUTTER, TODAY, null, 'for sawing', 0]);
  assert.deepEqual(out.inputs, [h.input(l14)]);
  assert.deepEqual(out.outputs, [{
    code: 'L14', new: false, lot_id: l14.id, carats: 80, pieces: null, damaged_pieces: 0, cost: 30000, to: 'work', item_kind: 'rough',
    revision: 0, weight_estimated: false, line: null, attrs: {},
  }]);

  // 10 ct and 4 of the 16 pieces of L30 go out: a new lot with the cutter, the rest stays in stores.
  const draft = stockOp({ kind: 'move', direction: 'out_work', inputs: [{ lot: 'L30', carats: 10, pieces: 4 }, { lot: 'L14' }], holder: N.CUTTER });
  const part = await stable(draft);
  const [next] = await store.nextCodes(user.id, 1);
  assert.deepEqual(part.outputs.map(brief), [[next, true, 10, 4, 10000, 'work', 'rough', 0], ['L14', false, 80, null, 30000, 'work', 'rough', 0]]);
  assert.deepEqual([part.outputs[0].line, part.outputs[0].attrs, part.outputs[0].lot_id], [null, { form: 'rough' }, null]);
  await apply(part);
  const sent = await lot(next);
  assert.deepEqual([sent.location, sent.holder, sent.carats, sent.pieces, sent.cost], ['work', N.CUTTER, 10, 4, 10000]);
  assert.deepEqual([(await lot('L30')).carats, (await lot('L30')).pieces, (await lot('L14')).location], [30, 12, 'work']);

  // Back: the holder is the one on record; a part that comes back is a new lot in stores.
  const back = await stable(stockOp({ kind: 'move', direction: 'return', inputs: [{ lot: 'L14' }, { lot: next, carats: 4, pieces: 1 }], holder: 'somchai' }));
  const [another] = await store.nextCodes(user.id, 1);
  assert.deepEqual([back.direction, back.holder, back.due_date], ['return', N.CUTTER, null]);
  assert.deepEqual(back.inputs.map((x) => [x.code, x.from, x.whole]), [['L14', 'work', true], [next, 'work', false]]);
  assert.deepEqual(back.outputs.map(brief), [['L14', false, 80, null, 30000, 'stores', 'rough', 0], [another, true, 4, 1, 4000, 'stores', 'rough', 0]]);
  await apply(back);
  assert.deepEqual([(await lot('L14')).location, (await lot('L14')).holder, (await lot(another)).location, (await lot(next)).carats], ['stores', null, 'stores', 6]);
});

test('move: refusals', async () => {
  const move = (sop, extra) => refused(stockOp({ kind: 'move', direction: 'out_work', inputs: [{ lot: 'L14' }], holder: N.CUTTER, ...sop }, extra));
  assert.match(await move({ direction: 'sideways' }), /^A move needs stock_op\.direction: out_work, out_memo, return\./);
  assert.match(await move({ holder: ' ' }), /^A lot going out needs stock_op\.holder: who has the stones\. Ask the trader who lot L14 went to\./);
  assert.match(await move({ inputs: [{ lot: 'L40' }] }), /^Lot L40 is already out for work with Somchai Cutting\. Record its return first \(a move with direction return\), then send it out again\./);
  assert.match(await move({ direction: 'out_memo', inputs: [{ lot: 'L16' }] }), /^Lot L16 is already out on memo with Siam Jewels\./);
  assert.match(await move({ inputs: [{ lot: 'L14', carats: 100 }] }), /^Lot L14 holds 80 ct; you cannot take 100 ct from it\./);
  assert.match(await move({ inputs: [{ lot: 'L404' }] }), /^Lot L404 is not on record for this account\./);
  assert.match(await move({ inputs: [{ lot: 'L12' }] }), /^Lot L12 is empty/);
  assert.match(await move({ due_date: 'next week' }), /^The due date "next week" is not a date\./);
  assert.match(await move({ due_date: day(-3) }), new RegExp(`^The due date ${day(-3)} is before the day the stones went out \\(${TODAY}\\)\\.`));
  assert.match(await move({ direction: 'out_memo', memo_price_per_ct: -5 }), /^The memo price "-5" is not a price per carat\./);
  assert.match(await move({ direction: 'return' }), /^Lot L14 is in stores: there is nothing to return\./);
  assert.match(await move({ direction: 'return', inputs: [{ lot: 'L40' }], holder: 'Lek' }), /^Lot L40 is out for work with Somchai Cutting, not with Lek\. Ask the trader who returned it\./);
  assert.match(
    await move({ direction: 'return', inputs: [{ lot: 'L40' }, { lot: 'L16' }], holder: null }),
    /^These lots are out with different people \(L40: Somchai Cutting, L16: Siam Jewels\)\. Record each return on its own\./
  );
  assert.match(await move({ date: day(-1) }), /^Lot L14 was last changed on /);
  assert.match(await move({ date: day(2) }), /is in the future/);
  assert.match(await move({}, { amount: 250 }), /^Only a transform \(cutting, heating, …\) carries a fee; a move moves no money\./);
  // A return needs no holder said: the one on record is used.
  const back = await resolved(stockOp({ kind: 'move', direction: 'return', inputs: ['L40'] }));
  assert.deepEqual([back.holder, back.outputs[0].to, back.outputs[0].new], [N.CUTTER, 'stores', false]);
});

// ── writing off, and what holds for every kind ────────────────────────

test('write-off: inputs only, a reason, the whole lot or a part', async () => {
  const l44 = await lot('L44');
  const op = await stable(stockOp({ kind: 'write_off', inputs: [{ lot: 'L44' }, { lot: 'L40', carats: 2.5 }], reason: ' stolen ', note: 'police report 12' }));
  assert.deepEqual([op.kind, op.reason, op.note, op.loss_carats, op.outputs, op.holder, op.fee], ['write_off', 'stolen', 'police report 12', 5.5, [], null, null]);
  assert.deepEqual(op.inputs[0], h.input(l44));
  assert.deepEqual([op.inputs[1].from, op.inputs[1].carats, op.inputs[1].cost, op.inputs[1].whole], ['work', 2.5, 1250, false]);
  const off = (sop, extra) => refused(stockOp({ kind: 'write_off', inputs: [{ lot: 'L44' }], reason: 'lost', ...sop }, extra));
  assert.match(await off({ reason: '' }), /^A write-off needs stock_op\.reason/);
  assert.match(await off({ inputs: [{ lot: 'L44', carats: 3.5 }] }), /^Lot L44 holds 3 ct; you cannot take 3\.5 ct from it\./);
  assert.match(await off({ inputs: [{ lot: 'L404' }] }), /^Lot L404 is not on record for this account\./);
  assert.match(await off({ date: day(-1) }), /^Lot L44 was last changed on /);
  assert.match(await off({ date: day(2) }), /is in the future/);
  assert.match(await off({ date: '11/11/2026' }), /^The date "11\/11\/2026" is not a date\./);
  assert.match(await off({}, { amount: 10 }), /^Only a transform \(cutting, heating, …\) carries a fee; a write-off moves no money\./);
});

test('every kind: the draft must be one lot operation, and an operation follows the lot in time', async () => {
  assert.match(await refused(null), /^There is no draft to work out\./);
  assert.match(await refused({ amount: 100, items: [{ description: 'tools', qty: 1, rate: 100 }] }), /^This draft does nothing to a lot/);
  const both = { ...bill([{ carats: 1, form: 'cut', price: 1, pricing_basis: 'total', rate: 1 }]), stock_op: { kind: 'write_off', inputs: [{ lot: 'L44' }], reason: 'lost' } };
  assert.match(await refused(both), /^A stock operation and a purchase or sale of lots need separate confirmations\./);
  assert.match(await refused(stockOp({ kind: 'undo', reference: 'BPL-1' })), /^An undo is not worked out here/);
  assert.match(await refused(stockOp({ kind: 'polish', inputs: [{ lot: 'L44' }] })), /^stock_op\.kind must be one of split, merge, transform, move, write_off\./);

  // A lot last changed five days ago: an operation on that day or after it is fine, one before it is not.
  await h.seedLot(user, client, { code: 'L70', carats: 5, cost: 500, date: day(-5) });
  const off = (date) => stockOp({ kind: 'write_off', inputs: [{ lot: 'L70', carats: 1 }], reason: 'lost', date });
  assert.equal((await resolved(off(day(-5)))).date, day(-5));
  assert.equal((await resolved(off(day(-2)))).inputs[0].before.last_op_date, day(-5));
  assert.equal(
    await refused(off(day(-6))),
    `Lot L70 was last changed on ${day(-5)}, and this is dated ${day(-6)}, before that. An operation cannot be dated before the lot's last one: ask the trader for the right date.`
  );
  // No date on the operation: today by the user's own clock (Bangkok's unless their row says otherwise).
  const undated = await resolved({ stock_op: { kind: 'write_off', inputs: [{ lot: 'L70', carats: 1 }], reason: 'lost' } });
  assert.equal(undated.date, new Intl.DateTimeFormat('en-CA', { timeZone: user.timezone || 'Asia/Bangkok' }).format(new Date()));
  // The warnings are not part of what is confirmed; everything else is.
  const op = await resolved(off(TODAY));
  assert.equal(lots.opSignature({ ...op, warnings: ['anything'] }), lots.opSignature(op));
  assert.notEqual(lots.opSignature({ ...op, reason: 'stolen' }), lots.opSignature(op));
  assert.equal((await lot('L70')).carats, 5, 'resolving writes nothing');
});

// ── dates, and a re-weigh that looks like a slip ──────────────────────

test('dates: the default day and the "future" limit use the same clock, the user\'s own', async () => {
  const bangkok = await h.addUser({ timezone: 'Asia/Bangkok' });
  const newYork = await h.addUser({ timezone: 'America/New_York' });
  const nowhere = await h.addUser({ timezone: 'Mars/Olympus' });
  for (const u of [bangkok, newYork, nowhere]) await h.seedLot(u, client, { code: 'T1', carats: 5, cost: 500, date: '2020-01-01' });
  const off = (date) => stockOp({ kind: 'write_off', inputs: [{ lot: 'T1', carats: 1 }], reason: 'lost', date });
  const undated = { stock_op: { kind: 'write_off', inputs: [{ lot: 'T1', carats: 1 }], reason: 'lost' } };
  const noZone = { ...bangkok, timezone: null };

  // 01:30 in Bangkok on 11 March is still the evening of the 10th in UTC and New York.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-10T18:30:00Z') });
  try {
    assert.equal((await resolved(undated, {}, bangkok)).date, '2026-03-11');
    assert.equal((await resolved(off('2026-03-11'), {}, bangkok)).date, '2026-03-11', 'the default day is never "the future"');
    assert.match(await refused(off('2026-03-12'), {}, bangkok), /^The date 2026-03-12 is in the future\./);
    assert.equal((await resolved(undated, {}, newYork)).date, '2026-03-10');
    assert.match(await refused(off('2026-03-11'), {}, newYork), /^The date 2026-03-11 is in the future\./);
    assert.equal((await resolved(off('2026-03-10'), {}, newYork)).date, '2026-03-10');
    // No time zone, or one that does not exist: Bangkok's clock.
    assert.equal((await resolved(undated, {}, noZone)).date, '2026-03-11');
    assert.equal((await resolved(undated, {}, nowhere)).date, '2026-03-11');
  } finally {
    mock.timers.reset();
  }
});

test('dates: a day that is not on the calendar is refused, in the date and in the due date', async () => {
  const off = (date) => refused(stockOp({ kind: 'write_off', inputs: [{ lot: 'L70', carats: 1 }], reason: 'lost', date }));
  for (const date of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00']) {
    assert.match(await off(date), new RegExp(`^The date "${date}" is not a day on the calendar\\. Ask the trader when it happened\\.$`), date);
  }
  assert.match(await off('30/02/2026'), /^The date "30\/02\/2026" is not a date\. Give it as YYYY-MM-DD/);
  const out = (due) => refused(stockOp({ kind: 'move', direction: 'out_work', inputs: [{ lot: 'L70' }], holder: N.CUTTER, due_date: due }));
  assert.match(await out('2026-02-30'), /^The due date "2026-02-30" is not a day on the calendar\. Ask the trader when the stones are due back\./);
  assert.match(await out('soon'), /^The due date "soon" is not a date\./);
  // A real leap day is a day.
  await h.seedLot(user, client, { code: 'T2', carats: 5, cost: 500, date: '2020-01-01' });
  assert.equal((await resolved(stockOp({ kind: 'write_off', inputs: [{ lot: 'T2', carats: 1 }], reason: 'lost', date: '2024-02-29' }))).date, '2024-02-29');
});

test('re-weigh: a weight far from the one on record is a warning on the card, not a refusal', async () => {
  await h.seedLot(user, client, { code: 'RW1', carats: 100, cost: 1000 });
  const reweigh = (carats) => resolved(stockOp({ kind: 'transform', job: 'reweigh', inputs: [{ lot: 'RW1' }], outputs: [{ carats }] }));
  const slip = await reweigh(10000);
  assert.deepEqual([slip.kind, slip.job, slip.outputs[0].carats, slip.outputs[0].cost], ['transform', 'reweigh', 10000, 1000], 'still resolved');
  assert.deepEqual(slip.warnings, ['The re-weigh gives 10000 ct where 100 ct was on record: 100 times more. That is a big change for a correction. Check the weight (1 gram = 5 carats).']);
  assert.match((await reweigh(40)).warnings[0], /gives 40 ct where 100 ct was on record: 2\.5 times less\./);
  assert.deepEqual((await reweigh(104.5)).warnings, []);
  assert.deepEqual((await reweigh(200)).warnings, []);
  // The warning is advice: it does not change what is confirmed.
  assert.equal(lots.opSignature({ ...slip, warnings: [] }), lots.opSignature(slip));
});

test('a new lot\'s code with a space in it is refused, not closed up into another code', async () => {
  const split = (code) => stockOp({ kind: 'split', inputs: [{ lot: 'RW1', carats: 10 }], outputs: [{ code, carats: 6, value: 6 }, { carats: 4, value: 4 }] });
  assert.match(await refused(split('R W 9')), /^stock_op\.outputs\[0\]\.code "R W 9" has a space in it, and a lot code has none\./);
  assert.match(await refused(bill([{ code: 'A B', carats: 5, form: 'cut', price: 100, pricing_basis: 'total', rate: 100 }])), /^items\[0\]\.lot\.code "A B" has a space in it/);
  assert.deepEqual((await resolved(split(' rw9 '))).outputs.map((o) => o.code), ['RW9', 'L' + (await store.nextCodes(user.id, 1))[0].slice(1)], 'spaces around a code are only trimmed');
  assert.equal((await lot('RW9')), null, 'nothing was written');
});
