/**
 * The lot part of a chat draft (src/lots/draft.js prepare) and the money validation a prepared
 * lot draft then goes through (src/tools/validate.js). No resolver, no ERPNext posting: prepare
 * only shapes the draft and says what is missing. Tests share the seeded lots and run in order.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const { prepare } = require('../src/lots/draft');
const { validateDraft, readinessError, applyDefaults, taxAndItemsError } = require('../src/tools/validate');
const { cardSignature } = require('../src/tools/request-confirmation');
const { localClock } = require('../src/jobs');

const erp = new FakeErpNext();
let user;
let client;
let byWeight;
let other;
let vatUser;

const TODAY = localClock(new Date()).date; // the user's own day (Asia/Bangkok unless they set one)
const copy = (v) => JSON.parse(JSON.stringify(v));

/** A purchase of one lot; `lot` overrides the block, `extra` the draft. */
const buying = (lot = {}, extra = {}) => ({
  transaction_type: 'bill_received', counterparty_name: h.N.SUPPLIER, counterparty_contact_skipped: true, payment_terms: 'net_30',
  currency: 'THB', transaction_date: TODAY,
  items: [{ lot: { carats: 200, form: 'rough', variety: 'sapphire', price: 1500, pricing_basis: 'per_ct', ...lot } }],
  ...extra,
});
const selling = (lot = {}, extra = {}) => ({
  transaction_type: 'invoice_issued', counterparty_name: h.N.CUSTOMER, counterparty_contact_skipped: true, payment_terms: 'net_30',
  currency: 'THB', transaction_date: TODAY,
  items: [{ lot: { code: 'L16', carats: 5.5, price: 27000, pricing_basis: 'per_ct', ...lot } }],
  ...extra,
});
const op = (stockOp, extra = {}) => ({ stock_op: stockOp, ...extra });
const cutting = (stockOp = {}, extra = {}) => op(
  { kind: 'transform', job: 'cutting', inputs: [{ lot: 'L13' }], outputs: [{ carats: 30, pieces: 42 }], ...stockOp },
  extra
);

/** prepare must refuse with a message matching `re`. */
async function refuses(draft, re, u = user) {
  const problem = await prepare(u, draft);
  assert.equal(typeof problem, 'string', `expected a refusal matching ${re}, got ${problem}`);
  assert.match(problem, re);
}
/** prepare must accept, and a second run must leave the draft exactly as the first did. */
async function accepts(draft, u = user) {
  assert.equal(await prepare(u, draft), null);
  const once = JSON.stringify(draft);
  assert.equal(await prepare(u, draft), null);
  assert.equal(JSON.stringify(draft), once, 'prepare is not idempotent');
  return draft;
}

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
  byWeight = await h.addUser({ method: 'weight' });
  other = await h.addUser({ niche: null });
  vatUser = await h.addUser({ vat_registered: 1 });
  await h.seedLot(user, client, { code: 'L16', carats: 8, cost: 175741.94, form: 'cut', attrs: { variety: 'sapphire', colour: 'blue' } });
  await h.seedLot(user, client, { code: 'L17', carats: 22, cost: 96658.06, form: 'cut', attrs: { description: 'commercial blue sapphire' } });
});

// ── lot lines ────────────────────────────────────────────────────────

test('a purchase line is normalised: code, carats to 3 dp, total worked out, line rewritten', async () => {
  const d = await accepts(buying({ code: ' l 12 ', carats: 200.00049, pieces: '40', form: 'Rough', treatment: 'h-fh', colour: ' blue ', origin: '' }));
  assert.deepEqual(d.items, [{
    description: 'blue sapphire rough', qty: 1, rate: 300000,
    lot: { code: 'L12', carats: 200, pieces: 40, form: 'rough', treatment: 'H-FH', colour: 'blue', variety: 'sapphire', price: 1500, pricing_basis: 'per_ct' },
  }]);
  assert.equal(d.direction, 'expense');
  assert.equal(d.category_code, '5000');
  assert.equal(d.amount, undefined); // the money path sums the lines, prepare never sets the amount
});

test('every pricing basis gives the line total; one gram is five carats', async () => {
  const total = async (lot) => (await accepts(buying(lot))).items[0].rate;
  assert.equal(await total({ carats: 200, price: 1500, pricing_basis: 'per_ct' }), 300000);
  assert.equal(await total({ carats: 200, price: 7500, pricing_basis: 'per_g' }), 300000);
  assert.equal(await total({ carats: 10000, price: 150000, pricing_basis: 'per_kg' }), 300000);
  assert.equal(await total({ carats: 30, pieces: 42, price: 500, pricing_basis: 'per_piece' }), 21000);
  assert.equal(await total({ carats: 200, price: 299999.5, pricing_basis: 'total' }), 299999.5);
  assert.equal(await total({ carats: 1.234, price: 333.33, pricing_basis: 'PER_CT' }), 411.33);
  await refuses(buying({ carats: 30, price: 500, pricing_basis: 'per_piece' }), /priced per piece, so it needs pieces/);
  await refuses(buying({ carats: 0.001, price: 1, pricing_basis: 'per_ct' }), /comes to less than 0\.01/);
});

test('the model never sets the line total: its rate and qty are replaced, a missing price is asked for', async () => {
  const d = buying();
  Object.assign(d.items[0], { rate: 1, qty: 200, description: 'Mogok rough' });
  await accepts(d);
  assert.deepEqual([d.items[0].description, d.items[0].qty, d.items[0].rate], ['Mogok rough', 1, 300000]);
  for (const lot of [{ price: null }, { price: 0 }, { pricing_basis: null }, { pricing_basis: 'per_pound' }]) {
    await refuses(buying(lot), /needs price and pricing_basis .*do not put it in rate/);
  }
});

test('a purchase line must say the weight, the form and what the stones are', async () => {
  await refuses(buying({ carats: null }), /items\[0\]\.lot needs the weight in carats.*1 gram = 5 carats.*Never guess/);
  await refuses(buying({ carats: -3 }), /carats -3 must be more than 0/);
  await refuses(buying({ carats: 0.0004 }), /must be more than 0/);
  await refuses(buying({ pieces: 2.5 }), /pieces 2\.5 must be a whole number/);
  await refuses(buying({ pieces: 0 }), /pieces 0 must be a whole number/);
  await refuses(buying({ form: null }), /needs form \(rough, preform, cut, cabochon, bead\)/);
  await refuses(buying({ form: 'faceted' }), /form "faceted" is not one of/);
  await refuses(buying({ treatment: 'baked' }), /treatment "baked" is not one of/);
  await refuses(buying({ variety: null }), /needs to say what the stones are/);
  await accepts(buying({ variety: null, species: 'corundum' }));
  await accepts(buying({ variety: null, description: 'mixed rough' }));
  await refuses(buying({ code: 'L 12!' }), /code "L 12!" cannot be a lot code/);
});

test('lot lines live on a bill or an invoice only, one lot per line, never with an item_code', async () => {
  for (const tt of ['cash', 'payment', undefined]) {
    await refuses(buying({}, { transaction_type: tt }), /Lots are bought on a bill and sold on an invoice.*net_0/);
  }
  await refuses({ ...buying(), items: [{ lot: 'L12' }] }, /items\[0\]\.lot must be an object/);
  const coded = buying();
  coded.items[0].item_code = 'PA2293';
  await refuses(coded, /has both lot and item_code/);
  const twice = selling();
  twice.items.push({ lot: { code: 'l16', carats: 1, price: 27000, pricing_basis: 'per_ct' } });
  await refuses(twice, /Lot L16 is on two lines/);
});

test('a sale line names the lot; its description comes from the lot when none is said', async () => {
  const d = await accepts(selling({ code: 'l16' }));
  assert.deepEqual(d.items, [{ description: 'blue sapphire cut', qty: 1, rate: 148500, lot: { code: 'L16', carats: 5.5, price: 27000, pricing_basis: 'per_ct' } }]);
  assert.equal(d.direction, 'income');
  assert.equal(d.category_code, undefined);
  assert.equal((await accepts(selling({ code: 'L17', carats: 2 }))).items[0].description, 'commercial blue sapphire');
  assert.equal((await accepts(selling({ code: 'L99' }))).items[0].description, 'Lot L99'); // whether it exists is the resolver's business
  await refuses(selling({ code: null }), /needs the code of the lot being sold.*Never guess/);
});

test('a sale line without carats sells the whole lot, weight read from the lot; a sale is not priced per gram or kilo', async () => {
  const d = await accepts(selling({ code: 'L16', carats: null }));
  assert.deepEqual(d.items[0].lot, { code: 'L16', price: 27000, pricing_basis: 'per_ct', carats: 8 });
  assert.equal(d.items[0].rate, 216000);
  await refuses(selling({ code: 'L99', carats: null }), /lot L99 is not on record/);
  await refuses(selling({ code: 'L16', carats: null, pricing_basis: 'per_piece' }), /is priced per piece, so it needs pieces/);
  await refuses(selling({ pricing_basis: 'per_g' }), /a sale is priced per_ct, per_piece or total, not per_g/);
  await refuses(selling({ pricing_basis: 'per_kg' }), /not per_kg/);
  await accepts(buying({ pricing_basis: 'per_g' })); // buying by weight is as before
  await accepts(selling({ pricing_basis: 'total', price: 148500 }));
});

test('other lines of the same bill are left alone', async () => {
  const d = buying();
  d.items.push({ description: 'shipping', qty: 1, rate: 500 });
  await accepts(d);
  assert.deepEqual(d.items[1], { description: 'shipping', qty: 1, rate: 500 });
  const plain = { transaction_type: 'bill_received', items: [{ description: 'ruby', qty: 1, rate: 100, item_code: 'PA1' }] };
  const before = copy(plain);
  assert.equal(await prepare(user, plain), null);
  assert.deepEqual(plain, before);
  assert.equal(await prepare(user, {}), null);
});

test('a prepared lot purchase and sale pass the money validation', async () => {
  for (const draft of [buying(), selling()]) {
    await accepts(draft);
    await applyDefaults(user, draft);
    assert.deepEqual(validateDraft(draft), []);
    assert.equal(await readinessError(user, draft, () => client), null);
  }
  // VAT on a lot bill goes through the same checks as on any bill.
  const taxed = buying({}, { tax_rate: 7, tax_inclusive: true });
  await accepts(taxed);
  await applyDefaults(vatUser, taxed);
  assert.deepEqual(validateDraft(taxed), []);
  assert.equal(await readinessError(vatUser, taxed, () => client), null);
  const bought = buying();
  await accepts(bought);
  await applyDefaults(user, bought);
  assert.equal(bought.amount, 300000);
});

test('validation: a lot line needs its total, never sits on a cash entry, and is refused without lot tracking', async () => {
  const raw = buying();
  await applyDefaults(user, raw); // not prepared: no rate on the line yet
  assert.match(validateDraft(raw).join(' '), /amount \(.*lot line with no total yet/);

  const cash = buying({}, { transaction_type: 'cash', direction: 'expense', category_code: '5000', payment_account_id: 1, amount: 300000 });
  cash.items[0] = { description: 'rough', qty: 1, rate: 300000, lot: cash.items[0].lot };
  assert.match(await readinessError(user, cash, () => client), /lot/i);

  const general = buying();
  await accepts(general);
  await applyDefaults(other, general);
  const refusal = await readinessError(other, general, () => client);
  assert.match(refusal, /Lot tracking is not switched on for this account/);
  assert.doesNotMatch(refusal, /set_gem_settings/); // nothing here invites the model to switch it on
  assert.match(await readinessError(other, { stock_op: { kind: 'split' } }, () => client), /Lot tracking is not switched on/);
});

test('validation: category 5010 only with a transform stock_op', async () => {
  const fee = { transaction_type: 'bill_received', counterparty_name: h.N.CUTTER, counterparty_contact_skipped: true, payment_terms: 'net_30',
    currency: 'THB', transaction_date: TODAY, direction: 'expense', amount: 2400, category_code: '5010' };
  assert.match(await readinessError(user, { ...fee }, () => client), /category_code 5010 is set by the system/);
  assert.match(await readinessError(user, { ...fee, stock_op: { kind: 'move', direction: 'return', inputs: [{ lot: 'L16' }] } }, () => client), /category_code 5010/);
  const cut = cutting({ fee_basis: 'per_ct', fee_rate: 80 }, { ...fee, amount: undefined });
  await accepts(cut);
  await applyDefaults(user, cut);
  assert.deepEqual(validateDraft(cut), []);
  assert.equal(await readinessError(user, cut, () => client), null);
});

// ── stock operations ─────────────────────────────────────────────────

test('stock_op: the kind, and what belongs to which kind', async () => {
  await refuses({ stock_op: 'split' }, /stock_op must be an object; set it with update_stock_op/);
  await refuses(op({}), /stock_op\.kind must be one of: split .*undo/);
  await refuses(op({ kind: 'polish' }), /stock_op\.kind must be one of/);
  await refuses(op({ kind: 'transform', inputs: [{ lot: 'L13' }], outputs: [{ carats: 30 }] }), /A transform needs stock_op\.job: cutting, sawing, heating, preform, recut, reweigh/);
  await refuses(cutting({ job: 'polishing' }), /A transform needs stock_op\.job/);
  await refuses(op({ kind: 'split', job: 'cutting', inputs: [{ lot: 'L12' }] }), /job belongs to a transform/);
  await refuses(op({ kind: 'move', direction: 'return', fee_basis: 'fixed', fee_rate: 100, inputs: [{ lot: 'L12' }] }), /fee_basis, fee_rate belong to a transform/);
  await refuses(op({ kind: 'move', inputs: [{ lot: 'L12' }] }), /A move needs stock_op\.direction: out_work .*out_memo .*return/);
  await refuses(op({ kind: 'move', direction: 'sideways', inputs: [{ lot: 'L12' }] }), /A move needs stock_op\.direction/);
  await refuses(op({ kind: 'write_off', direction: 'return', inputs: [{ lot: 'L12' }], reason: 'lost' }), /direction is only for a move/);
  await refuses(op({ kind: 'write_off', reference: 'BPL-1', inputs: [{ lot: 'L12' }], reason: 'lost' }), /reference and stock_op\.lot are only for an undo/);
  await refuses(op({ kind: 'write_off', inputs: [{ lot: 'L12' }], reason: 'lost' }, { amount: 500 }), /Only a transform .* carries a fee; a write_off moves no money/);
  const d = await accepts(cutting({ kind: 'Transform', job: 'CUTTING' }));
  assert.deepEqual([d.stock_op.kind, d.stock_op.job], ['transform', 'cutting']);
});

test('stock_op inputs: codes normalised, a bare code accepted, each lot once', async () => {
  const d = await accepts(op({ kind: 'write_off', reason: ' broken ', inputs: ['l 12', { code: 'l13', carats: '1.23456', pieces: '2' }, { lot: 'L14', carats: null, pieces: '' }] }));
  assert.deepEqual(d.stock_op.inputs, [{ lot: 'L12' }, { carats: 1.235, pieces: 2, lot: 'L13' }, { lot: 'L14' }]);
  assert.equal(d.stock_op.reason, 'broken');
  const base = { kind: 'write_off', reason: 'lost' };
  await refuses(op({ ...base }), /stock_op\.inputs must list the lot\(s\).*Never guess/);
  await refuses(op({ ...base, inputs: [] }), /stock_op\.inputs must list/);
  await refuses(op({ ...base, inputs: [12] }), /inputs\[0\] must be \{ lot, carats\?, pieces\? \}/);
  await refuses(op({ ...base, inputs: [{ carats: 3 }] }), /inputs\[0\] needs the lot code/);
  await refuses(op({ ...base, inputs: [{ lot: '??' }] }), /lot "\?\?" cannot be a lot code/);
  await refuses(op({ ...base, inputs: [{ lot: 'L12' }, { lot: 'l12' }] }), /Lot L12 is listed twice/);
  await refuses(op({ ...base, inputs: [{ lot: 'L12', carats: 0 }] }), /carats 0 must be more than 0/);
  await refuses(op({ ...base, inputs: [{ lot: 'L12', pieces: 1.5 }] }), /pieces 1\.5 must be a whole number/);
});

test('split: one lot in, parts out; a by-value account needs a value on every part', async () => {
  const parts = [{ carats: 120, value_per_ct: 2250, grade: ' A ' }, { carats: 80, value_per_ct: 375 }];
  const d = await accepts(op({ kind: 'split', inputs: ['L12'], outputs: copy(parts) }));
  assert.deepEqual(d.stock_op, {
    kind: 'split', inputs: [{ lot: 'L12' }], outputs: [{ carats: 120, value_per_ct: 2250, grade: 'A' }, { carats: 80, value_per_ct: 375 }], date: TODAY,
  });
  await refuses(op({ kind: 'split', inputs: ['L12', 'L13'], outputs: copy(parts) }), /A split works on one lot at a time/);
  await refuses(op({ kind: 'split', inputs: ['L12'] }), /A split needs stock_op\.outputs.*Never guess/);
  await refuses(op({ kind: 'split', inputs: ['L12'], outputs: [{ carats: 120, value_per_ct: 2250 }, { carats: 80 }] }),
    /shares cost by value, so every output needs.*Missing on output 2 \(80 ct\).*Never guess/);
  await refuses(op({ kind: 'split', inputs: ['L12'], outputs: [{ carats: 120, value_per_ct: 2250, value: 270000 }, { carats: 80, value: 30000 }] }),
    /has both value_per_ct and value/);
  await refuses(op({ kind: 'split', inputs: ['L12'], outputs: [{ carats: 120, value_per_ct: -1 }, { carats: 80, value: 30000 }] }), /value_per_ct -1 must be more than 0/);
  // Whole-output values work too, and an account that shares by weight needs none.
  await accepts(op({ kind: 'split', inputs: ['L12'], outputs: [{ carats: 120, value: 270000 }, { carats: 80, value: 30000 }] }));
  await accepts(op({ kind: 'split', inputs: ['L12'], outputs: [{ carats: 120 }, { carats: 80 }] }), byWeight);
  // One part taken out of a lot: nothing to share, so no value is asked.
  await accepts(op({ kind: 'split', inputs: [{ lot: 'L12', carats: 50 }], outputs: [{ carats: 50 }] }));
});

test('outputs: weight required, codes and attributes checked', async () => {
  const out = (o) => cutting({ outputs: [{ carats: 30, ...o }] });
  await refuses(cutting({ outputs: ['30 ct'] }), /outputs\[0\] must be \{ carats/);
  await refuses(out({ carats: null }), /outputs\[0\] needs the weight in carats/);
  await refuses(out({ code: '#1' }), /code "#1" cannot be a lot code/);
  await refuses(cutting({ outputs: [{ carats: 10, code: 'L20', value: 1 }, { carats: 20, code: 'l20', value: 1 }] }), /Lot L20 is given to two outputs/);
  await refuses(out({ damaged_pieces: -1 }), /damaged_pieces -1 must be a whole number/);
  await refuses(out({ damaged_pieces: 1.5 }), /damaged_pieces 1\.5 must be a whole number/);
  await refuses(out({ form: 'shiny' }), /outputs\[0\]\.form "shiny" is not one of/);
  await refuses(out({ treatment: 'heated' }), /outputs\[0\]\.treatment "heated" is not one of/);
  const d = await accepts(out({ code: ' l15 ', carats: 30.0004, pieces: '42', damaged_pieces: '2', form: 'CUT', treatment: 'h', shape: ' oval ', value: 100.005, grade: '' }));
  assert.deepEqual(d.stock_op.outputs, [{ carats: 30, code: 'L15', pieces: 42, damaged_pieces: 2, form: 'cut', treatment: 'H', shape: 'oval', value: 100.01 }]);
});

test('merge: at least two lots, one result, its weight summed from the lots', async () => {
  const d = await accepts(op({ kind: 'merge', inputs: ['l16', 'L17'] }));
  assert.deepEqual(d.stock_op.outputs, [{ carats: 30 }]);
  const part = await accepts(op({ kind: 'merge', inputs: [{ lot: 'L16', carats: 3 }, { lot: 'L17' }], outputs: [{ code: 'L17' }] }));
  assert.deepEqual(part.stock_op.outputs, [{ code: 'L17', carats: 25 }]);
  const said = await accepts(op({ kind: 'merge', inputs: ['L16', 'L17'], outputs: [{ carats: 29.9 }] }));
  assert.equal(said.stock_op.outputs[0].carats, 29.9);
  await refuses(op({ kind: 'merge', inputs: ['L16'] }), /A merge needs at least two lots/);
  await refuses(op({ kind: 'merge', inputs: ['L16', 'L404'] }), /Lot L404 is not on record/);
  await refuses(op({ kind: 'merge', inputs: ['L16', 'L17'], outputs: [{ carats: 10 }, { carats: 20 }] }), /A merge makes one lot: give one output/);
});

test('move and write-off: no outputs; a holder when stones go out, a reason when they are written off', async () => {
  const out = await accepts(op({ kind: 'move', direction: 'OUT_MEMO', inputs: [{ lot: 'L16', carats: 3 }], holder: ' Jameel ', due_date: '2026-12-31', memo_price_per_ct: '30000', outputs: [] }));
  assert.deepEqual(out.stock_op, { kind: 'move', direction: 'out_memo', inputs: [{ lot: 'L16', carats: 3 }], holder: 'Jameel', due_date: '2026-12-31', memo_price_per_ct: 30000, date: TODAY });
  await accepts(op({ kind: 'move', direction: 'return', inputs: ['L16'] }));
  await refuses(op({ kind: 'move', direction: 'out_work', inputs: ['L13'] }), /holder is missing: who takes the stones \(the cutter or heater\)/);
  await refuses(op({ kind: 'move', direction: 'out_memo', inputs: ['L13'] }), /holder is missing: who takes the stones \(the broker or customer\)/);
  await refuses(op({ kind: 'move', direction: 'out_work', inputs: ['L13'], holder: 'Lek', outputs: [{ carats: 120 }] }), /A move has no outputs/);
  await refuses(op({ kind: 'move', direction: 'out_work', inputs: ['L13'], holder: 'Lek', due_date: 'next week' }), /due_date "next week" must be YYYY-MM-DD/);
  await refuses(op({ kind: 'move', direction: 'out_memo', inputs: ['L13'], holder: 'Lek', memo_price_per_ct: -5 }), /memo_price_per_ct -5 must be more than 0/);
  await refuses(op({ kind: 'write_off', inputs: ['L13'] }), /A write-off needs stock_op\.reason/);
  await refuses(op({ kind: 'write_off', inputs: ['L13'], reason: 'lost', outputs: [{ carats: 1 }] }), /A write_off has no outputs/);
});

test('the fee of a transform: worked out from the quoted rate, never by the model', async () => {
  const money = { transaction_type: 'cash', direction: 'expense', counterparty_name: 'Lek' };
  const perCt = await accepts(cutting({ fee_basis: 'PER_CT', fee_rate: '80' }, { ...money }));
  assert.equal(perCt.amount, 2400);
  assert.deepEqual([perCt.stock_op.fee_basis, perCt.stock_op.fee_rate], ['per_ct', 80]);
  assert.equal((await accepts(cutting({ fee_basis: 'per_piece', fee_rate: 50 }, { ...money }))).amount, 2100);
  assert.equal((await accepts(cutting({ fee_basis: 'fixed', fee_rate: 5000 }, { ...money }))).amount, 5000);
  assert.equal((await accepts(cutting({ outputs: [{ carats: 20.5, value: 1 }, { carats: 9.5, value: 1 }], fee_basis: 'per_ct', fee_rate: 80 }, { ...money }))).amount, 2400);
  // An amount the trader said stands when it agrees, and is questioned when it does not.
  assert.equal((await accepts(cutting({ fee_basis: 'per_ct', fee_rate: 80 }, { ...money, amount: 2400 }))).amount, 2400);
  await refuses(cutting({ fee_basis: 'per_ct', fee_rate: 80 }, { ...money, amount: 2500 }), /amount 2500 does not match the fee as quoted \(80 × 30 = 2400\)/);
  // What was transferred after withholding: the gross is the money path's to work out.
  assert.equal((await accepts(cutting({ fee_basis: 'per_ct', fee_rate: 80 }, { ...money, paid_after_wht: 2328, wht_rate: 3 }))).amount, undefined);
  // A fee with no rate is just the draft amount; no fee at all is fine.
  assert.equal((await accepts(cutting({ fee_basis: 'mixed' }, { ...money, amount: 3000 }))).amount, 3000);
  assert.equal((await accepts(cutting())).amount, undefined);

  await refuses(cutting({ fee_basis: 'hourly', fee_rate: 80 }), /fee_basis "hourly" is not one of per_ct, per_piece, fixed, mixed/);
  await refuses(cutting({ fee_basis: 'per_ct', fee_rate: -1 }), /fee_rate -1 must be more than 0/);
  await refuses(cutting({ fee_rate: 80 }), /fee_rate needs fee_basis per_ct/);
  await refuses(cutting({ fee_basis: 'mixed', fee_rate: 80 }), /fee_rate needs fee_basis per_ct/);
  await refuses(cutting({ outputs: [{ carats: 30 }], fee_basis: 'per_piece', fee_rate: 50 }), /A fee per piece needs pieces on every output/);
  await refuses(cutting({}, { transaction_type: 'invoice_issued', amount: 2400 }), /The fee for the work is money the trader pays/);
  await refuses(cutting({}, { transaction_type: 'cash', direction: 'income', amount: 2400 }), /The fee for the work is money the trader pays/);
  await refuses(cutting({}, { transaction_type: 'bill_received', amount: 2400, items: [{ item_code: 'PA1', qty: 1, rate: 2400 }] }), /cannot carry stock items/);
});

test('one date for the stones and the fee; today when none is said', async () => {
  assert.equal((await accepts(cutting())).stock_op.date, TODAY);
  const fee = await accepts(cutting({}, { amount: 2400, transaction_date: '2026-11-02' }));
  assert.equal(fee.stock_op.date, '2026-11-02');
  const dated = await accepts(cutting({ date: '2026-11-03' }, { amount: 2400 }));
  assert.equal(dated.transaction_date, '2026-11-03');
  const noFee = await accepts(cutting({}, { transaction_date: '2026-11-02' })); // no money: the draft date is not this operation's
  assert.equal(noFee.stock_op.date, TODAY);
  await refuses(cutting({ date: '2026-11-03' }, { amount: 2400, transaction_date: '2026-11-02' }), /The fee is dated 2026-11-02 but the stones 2026-11-03/);
  await refuses(cutting({ date: '3 Nov' }), /stock_op\.date "3 Nov" must be YYYY-MM-DD/);
});

test('undo names an operation or a lot and nothing else, and carries no money', async () => {
  assert.deepEqual((await accepts(op({ kind: 'UNDO', reference: ' bpl-20261110-ab12 ' }))).stock_op, { kind: 'undo', reference: 'BPL-20261110-AB12' });
  assert.deepEqual((await accepts(op({ kind: 'undo', lot: ' l13 ', reference: '' }))).stock_op, { kind: 'undo', lot: 'L13' });
  assert.deepEqual((await accepts(op({ kind: 'undo', inputs: [], note: null }))).stock_op.kind, 'undo'); // neither: the newest operation
  await refuses(op({ kind: 'undo', lot: 'L13', inputs: [{ lot: 'L13' }] }), /An undo names only the operation.*Remove inputs from stock_op/);
  await refuses(op({ kind: 'undo', lot: 'L13', job: 'cutting', date: TODAY }), /Remove job, date from stock_op/);
  await refuses(op({ kind: 'undo', lot: 'L13' }, { amount: 100 }), /An undo carries no money and no items/);
  await refuses(op({ kind: 'undo', lot: 'L13' }, { items: [{ description: 'x', rate: 1 }] }), /An undo carries no money and no items/);
  await refuses(op({ kind: 'undo', lot: '!!' }), /stock_op\.lot "!!" cannot be a lot code/);
});

// ── loose input ──────────────────────────────────────────────────────

test('loose input is refused, clean numeric strings are read', async () => {
  for (const carats of [true, [3], Infinity, -Infinity, NaN, {}, 'abc', '1,5', '3 apples']) {
    await refuses(buying({ carats }), /needs the weight|carats .* must be more than 0/);
  }
  for (const pieces of [true, [2], Infinity, {}, '2.5']) await refuses(buying({ pieces }), /pieces .* must be a whole number/);
  await refuses(buying({ price: true }), /needs price and pricing_basis/);
  await refuses(buying({ price: Infinity }), /needs price and pricing_basis/);
  await refuses(buying({ pricing_basis: ['per_ct'] }), /needs price and pricing_basis/);
  await refuses(buying({ code: true }), /code "true" cannot be a lot code/);
  await refuses(buying({ colour: { name: 'blue' } }), /colour must be a word or a few words, not \{"name":"blue"\}/);
  await refuses(buying({ supplier_doc: 'maybe' }), /supplier_doc must be true or false/);
  await refuses(buying({ form: ['rough'] }), /form .* is not one of/);

  const d = await accepts(buying({ carats: '30 ct', pieces: '12 pcs', price: '1,500', size: 5, supplier_doc: 'false', vat_exempt: true }));
  assert.deepEqual([d.items[0].lot.carats, d.items[0].lot.pieces, d.items[0].lot.price, d.items[0].lot.size, d.items[0].lot.supplier_doc], [30, 12, 1500, '5', false]);
  assert.equal(d.items[0].rate, 45000);

  const move = (extra) => op({ kind: 'move', direction: 'out_work', inputs: ['L13'], ...extra });
  await refuses(move({ holder: { name: 'Lek' } }), /holder must be a word or a few words/);
  await refuses(move({ holder: ['Lek'] }), /holder must be a word/);
  await refuses(move({ holder: 'Lek', due_date: true }), /due_date must be a word/);
  await refuses(op({ kind: 'write_off', inputs: [{ lot: 'L13', carats: true }], reason: 'lost' }), /carats true must be more than 0/);
  await refuses(op({ kind: 'write_off', inputs: ['L13'], reason: { why: 'lost' } }), /reason must be a word/);
  await refuses(cutting({ outputs: [{ carats: '30', value: Infinity }] }), /value .* must be more than 0/);
  await refuses(cutting({ fee_basis: 'per_ct', fee_rate: true }, { transaction_type: 'cash' }), /fee_rate true must be more than 0/);
  await refuses(op({ kind: 'move', direction: ['out_work'], inputs: ['L13'], holder: 'Lek' }), /direction must be a word/);
  const ok = await accepts(move({ holder: 'Lek', inputs: [{ lot: 'L13', carats: '1,000 ct' }] }));
  assert.equal(ok.stock_op.inputs[0].carats, 1000);
});

test('a write-off, a split or a merge does not silently drop a holder, a due date or a memo price', async () => {
  await refuses(op({ kind: 'write_off', inputs: ['L13'], reason: 'lost', holder: 'Lek' }), /holder does not apply to this write_off.*Remove holder/);
  await refuses(op({ kind: 'split', inputs: ['L12'], outputs: [{ carats: 100, value: 1 }, { carats: 90, value: 1 }], due_date: '2027-01-01' }), /due_date does not apply to this split/);
  await refuses(op({ kind: 'merge', inputs: ['L16', 'L17'], holder: 'Lek' }), /holder does not apply to this merge/);
  await refuses(op({ kind: 'move', direction: 'return', inputs: ['L16'], due_date: '2027-01-01' }), /due_date does not apply to this move \(return\)/);
  await refuses(op({ kind: 'move', direction: 'out_work', inputs: ['L13'], holder: 'Lek', memo_price_per_ct: 100 }), /memo_price_per_ct does not apply to this move \(out_work\)/);
  await refuses(cutting({ due_date: '2027-01-01', memo_price_per_ct: 5 }), /due_date, memo_price_per_ct do not apply to this transform/);
  await accepts(cutting({ holder: 'Lek' })); // a transform keeps who did the work
  await accepts(op({ kind: 'move', direction: 'out_memo', inputs: ['L16'], holder: 'Jameel', due_date: '2027-01-01', memo_price_per_ct: 30000 }));
});

test('a stray lot string on a line is refused for a gem trader and ignored for everyone else', async () => {
  const line = { description: 'ruby', qty: 1, rate: 100, lot: 'L12' };
  const draft = { transaction_type: 'bill_received', direction: 'expense', amount: 100, items: [line] };
  assert.match(taxAndItemsError(user, draft), /items\[0\]\.lot must be an object/);
  assert.equal(taxAndItemsError(other, draft), null);
  assert.equal(validateDraft({ ...draft, amount: undefined, counterparty_name: 'x', currency: 'THB', transaction_date: TODAY, category_code: '5000' }).includes('amount'), true);
  const plain = { ...draft, amount: undefined };
  await applyDefaults(other, plain);
  assert.equal(plain.amount, 100); // summed as for any other line
});

test('the default date is the user\'s own day', async () => {
  const auckland = await h.addUser({ timezone: 'Pacific/Auckland' });
  const honolulu = await h.addUser({ timezone: 'Pacific/Honolulu' });
  for (const u of [auckland, honolulu]) {
    const d = await accepts(cutting(), u);
    assert.equal(d.stock_op.date, localClock(new Date(), u.timezone).date);
    const money = { transaction_type: 'cash', direction: 'expense', amount: 5, items: undefined };
    await applyDefaults(u, money);
    assert.equal(money.transaction_date, localClock(new Date(), u.timezone).date);
  }
});

// ── the fee ──────────────────────────────────────────────────────────

const GATE = (d) => { d.direction = 'expense'; d.category_code = lotsIndex.FEE_CATEGORY_CODE; }; // what the lot gate sets between prepare and applyDefaults
const lotsIndex = require('../src/lots');
const netOfWht = (stockOp = {}, extra = {}) => cutting(
  { fee_basis: 'per_ct', fee_rate: 80, ...stockOp },
  { transaction_type: 'cash', counterparty_name: 'Lek', currency: 'THB', wht_rate: 3, wht_form: 'PND3', paid_after_wht: 2328, ...extra }
);

test('prepare, applyDefaults, prepare: a fee paid net of withholding tax is the same draft and the same card at save time', async () => {
  const cases = [
    netOfWht(),                                                       // no date said: both runs say today
    netOfWht({ date: '2026-11-02' }),                                 // the stones' date is not today: applyDefaults must not move the fee's
    netOfWht({ date: '2026-11-02' }, { transaction_date: '2026-11-02' }),
    netOfWht({ fee_basis: 'fixed', fee_rate: 2400 }),
    netOfWht({}, { transaction_type: 'bill_received', payment_terms: 'net_30', counterparty_contact_skipped: true }),
    netOfWht({ fee_basis: undefined, fee_rate: undefined }, { paid_after_wht: 2328 }), // no rate: the paid figure alone
  ];
  for (const [n, draft] of cases.entries()) {
    assert.equal(await prepare(user, draft), null, `case ${n}: card time`);
    GATE(draft);
    await applyDefaults(user, draft);
    assert.equal(draft.amount, 2400, `case ${n}: the gross comes from what was paid`);
    const afterCard = JSON.stringify(draft);
    const signature = cardSignature(draft);

    assert.equal(await prepare(user, draft), null, `case ${n}: save time`);
    GATE(draft);
    await applyDefaults(user, draft);
    assert.equal(JSON.stringify(draft), afterCard, `case ${n}: the draft changed between the card and the save`);
    assert.equal(cardSignature(draft), signature, `case ${n}: the card signature changed`);
    assert.deepEqual(validateDraft(draft), []);
  }
});

test('a fee paid net of withholding tax that disagrees with the quoted fee is refused at card time, not at save time', async () => {
  // 1.5 per carat on 1 ct is 1.50; 1.45 after 3% grosses up to 1.49: ask, do not card something that cannot be saved.
  const rounding = netOfWht({ outputs: [{ carats: 1 }], fee_rate: 1.5 }, { paid_after_wht: 1.45 });
  await refuses(rounding, /Paid 1\.45 after 3% withholding tax means a fee of 1\.49, but the fee as quoted is 1\.5 × 1 = 1\.5\. Ask the trader which is right/);
  await refuses(netOfWht({}, { paid_after_wht: 2300 }), /Paid 2300 after 3% withholding tax means a fee of 2371\.1\d?, but the fee as quoted is 80 × 30 = 2400/);
  // Nothing exact to gross up to: not this check's business (validateDraft explains it, at card time and at save time alike).
  const inexact = await accepts(netOfWht({ outputs: [{ carats: 1 }], fee_rate: 1.5 }, { paid_after_wht: 0.22, tax_rate: 7, tax_inclusive: false }));
  GATE(inexact);
  await applyDefaults(user, inexact);
  assert.match(validateDraft(inexact).join(' '), /amount \(no invoice amount leaves exactly 0\.22 after 3% WHT and 7% VAT/);
  assert.equal(await prepare(user, inexact), null); // and the second run says the same
  // A paid figure with no withholding rate cannot be grossed up at all.
  const noRate = cutting({ fee_basis: 'per_ct', fee_rate: 80 }, { transaction_type: 'cash', paid_after_wht: 2328, currency: 'THB', counterparty_name: 'Lek' });
  assert.equal(await prepare(user, noRate), null);
  GATE(noRate);
  await applyDefaults(user, noRate);
  assert.match(validateDraft(noRate).join(' '), /paid_after_wht needs wht_rate/);
  // Paid-net money counts as money for the rest of the rules, so a split cannot carry it either.
  await refuses(op({ kind: 'split', inputs: ['L12'], outputs: [{ carats: 120, value: 1 }, { carats: 80, value: 1 }] }, { paid_after_wht: 100, wht_rate: 3 }), /Only a transform .* carries a fee; a split moves no money/);
});

test('a derived fee is marked fee_derived and follows the rate and the weights; a stated amount is left alone', async () => {
  const money = { transaction_type: 'cash', direction: 'expense', counterparty_name: 'Lek' };
  const derived = cutting({ fee_basis: 'per_ct', fee_rate: 80 }, { ...money });
  assert.equal(await prepare(user, derived), null);
  assert.deepEqual([derived.amount, derived.stock_op.fee_derived], [2400, true]);
  derived.stock_op.outputs[0].carats = 40; // the weight changed
  assert.equal(await prepare(user, derived), null);
  assert.deepEqual([derived.amount, derived.stock_op.fee_derived], [3200, true]);
  derived.stock_op.fee_rate = 90;
  assert.equal(await prepare(user, derived), null);
  assert.equal(derived.amount, 3600);
  delete derived.stock_op.fee_rate; // "no fee": the amount that came from the rate goes with it
  assert.equal(await prepare(user, derived), null);
  assert.deepEqual([derived.amount, derived.stock_op.fee_derived], [undefined, undefined]);

  const stated = cutting({ fee_basis: 'per_ct', fee_rate: 80 }, { ...money, amount: 2400 });
  assert.equal(await prepare(user, stated), null);
  assert.equal(stated.stock_op.fee_derived, undefined);
  stated.stock_op.outputs[0].carats = 40; // a sum the trader stated is not moved under them
  assert.match(await prepare(user, stated), /amount 2400 does not match the fee as quoted \(80 × 40 = 3200\)/);
  assert.equal(stated.amount, 2400);

  // Said as paid-net afterwards: the stated figure wins over the one worked out from the rate.
  const net = cutting({ fee_basis: 'per_ct', fee_rate: 80 }, { ...money });
  await prepare(user, net);
  Object.assign(net, { paid_after_wht: 2328, wht_rate: 3, wht_form: 'PND3' });
  assert.equal(await prepare(user, net), null);
  assert.equal(net.stock_op.fee_derived, undefined);
});
