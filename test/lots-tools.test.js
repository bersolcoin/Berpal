/**
 * The chat surface of lot tracking, through the same entry point the LLM uses (executeTool):
 * who sees the gem tools and the gem prompt, update_draft / update_stock_op filling a lot draft,
 * the two lot queries, set_lot_details and set_gem_settings. Lots are put on record through the
 * store (test/lots-helpers.js); the resolver and the ERPNext posting have their own tests.
 * Tests share the lots and run in order.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const db = require('../src/db');
const store = require('../src/lots/store');
const { TOOLS, toolsFor, executeTool } = require('../src/tools');
const prompt = require('../src/prompt');
const lotsSection = require('../src/prompt/65-lots');
const taxSection = require('../src/prompt/60-tax-items');
const updateDraft = require('../src/tools/update-draft');
const { prepare } = require('../src/lots/draft');
const { validateDraft, readinessError, applyDefaults, PROTECTED_DRAFT_KEYS } = require('../src/tools/validate');

const erp = new FakeErpNext();
let user;
let client;
let other;

const MINE = ['query_lot_history', 'query_lots', 'set_gem_settings', 'set_lot_details', 'update_stock_op'];
const BLUE = { variety: 'sapphire', colour: 'blue', description: 'blue sapphire rough' };
const names = (tools) => tools.map((t) => t.function.name);
const call = (name, args, u = user, draft = {}) => {
  const ctx = h.ctxFor(u, draft);
  return executeTool(name, args, ctx).then((result) => ({ result, ctx }));
};
const row = (id) => db.query('SELECT niche, lot_cost_method FROM users WHERE id = $1', [id]).then((r) => r.rows[0]);

before(async () => {
  erp.install();
  await h.freshDb();
  ({ user, client } = await h.setupGems());
  other = await h.addUser({ niche: null });
  // L12 bought, sorted into L13 + L14, L13 sent to the cutter; L16 is a cut lot of its own.
  const l12 = await h.seedLot(user, client, { ...h.WORKED.buy, attrs: BLUE });
  await h.recordPosted(user, h.resolvedOp({
    kind: 'split', inputs: [h.input(l12)],
    outputs: h.WORKED.split1.map((p) => h.output({ code: p.code, carats: p.carats, cost: p.cost, attrs: BLUE })),
  }));
  const l13 = await store.getLot(user.id, 'L13');
  await h.recordPosted(user, h.resolvedOp({
    kind: 'move', direction: 'out_work', holder: 'Lek', inputs: [h.input(l13)], outputs: [h.output({ lot: l13, carats: 120, cost: 270000, to: 'work' })],
  }));
  await h.seedLot(user, client, { code: 'L16', carats: 8, pieces: 5, cost: 175741.94, form: 'cut', attrs: { variety: 'sapphire', colour: 'blue', treatment: 'H' } });
});

// ── who sees what ────────────────────────────────────────────────────

test('a user without lot tracking gets the general tools only, and cannot call a gem tool', async () => {
  assert.deepEqual(toolsFor(other), TOOLS);
  assert.deepEqual(toolsFor(null), TOOLS);
  const general = names(TOOLS);
  for (const name of MINE) assert.ok(!general.includes(name), `${name} is offered to everyone`);
  // Lot tracking is switched on by provisioning, never from chat: the settings tool is for accounts that have it.

  for (const name of MINE) {
    const { result, ctx } = await call(name, { kind: 'split', lot: 'L12', grade: 'A' }, other);
    assert.deepEqual(result, { ok: false, error: `Unknown tool: ${name}` });
    assert.deepEqual(ctx.draft, {});
  }
  // The lots of the gem trader are untouched by the attempt.
  assert.equal((await store.getLot(user.id, 'L12')).grade, null);
});

test('a gem trader gets the general tools plus the lot tools', () => {
  const offered = names(toolsFor(user));
  assert.deepEqual(offered.filter((n) => names(TOOLS).includes(n)).sort(), names(TOOLS).sort());
  const extra = offered.filter((n) => !names(TOOLS).includes(n));
  for (const name of MINE) assert.ok(extra.includes(name), `${name} is missing`);
  assert.equal(new Set(offered).size, offered.length);
});

test('the prompt: nothing about lots without lot tracking, the lot section with it', () => {
  assert.equal(lotsSection({ user: other }), '');
  assert.equal(lotsSection({ user: null }), '');
  const today = h.TODAY;
  const general = prompt.render({ user: other, draft: {}, today });
  for (const word of ['GEM LOTS', 'update_stock_op', 'query_lots', 'set_lot_details', 'lot block']) {
    assert.ok(!general.includes(word), `"${word}" is in a general user's prompt`);
  }
  // The stock id section differs for a gem trader by one note, and by examples that do not look like lot codes ("R-17").
  const gemTax = taxSection({ user });
  const generalTax = taxSection({ user: { ...user, niche: null } });
  const note = gemTax.split('\n').filter((l) => l.includes('keeps parcels in LOTS'));
  assert.equal(note.length, 1);
  assert.ok(generalTax.includes('R-17') && !gemTax.includes('R-17'));
  assert.equal(gemTax.replace(`\n${note[0]}`, '').replace(/"pa2293", "PA-2293", "SKU 4471"/, '"pa2293", "PA-2293", "R-17", "SKU 4471"').replace('where is pa2293', 'where is R-17').replace('specific stone:', 'specific stone/lot:'), generalTax);
  const itemCode = (def) => def.parameters.properties.items.items.properties.item_code.description;
  assert.match(itemCode(updateDraft.definition), /lot R-17/);
  assert.doesNotMatch(itemCode(updateDraft.nicheDefinitions.gems), /R-17/);

  const section = lotsSection({ user });
  for (const word of ['GEM LOTS', 'update_stock_op', 'query_lots', 'query_custody', 'query_lot_history', 'set_lot_details', 'retry_stock_op', 'request_confirmation',
    'pricing_basis', '1 gram = 5 carats', 'kind:\'undo\'']) {
    assert.ok(section.includes(word), `the lot section does not mention ${word}`);
  }
  assert.ok(prompt.render({ user, draft: {}, today }).includes(section));
  assert.match(section, /shares cost BY VALUE: every output needs value_per_ct/);
  assert.match(lotsSection({ user: { ...user, lot_cost_method: 'weight' } }), /shares cost by weight: no values needed/);
});

// ── filling the draft ────────────────────────────────────────────────

test('update_draft cannot set a stock operation, the fee category or a server-only key', async () => {
  const forged = Object.fromEntries(PROTECTED_DRAFT_KEYS.map((k) => [k, 'forged']));
  const { result, ctx } = await call('update_draft', { amount: 100, stock_op: { kind: 'write_off', inputs: [{ lot: 'L16' }], reason: 'x' }, category_code: '5010', ...forged });
  assert.equal(result.ok, true);
  assert.deepEqual(ctx.draft, { amount: 100 });
  assert.deepEqual(result.current_draft, { amount: 100 });
  assert.match(result.note, /Not applied: stock_op is set with update_stock_op, not update_draft; category_code 5010 is set by the system/);

  // An operation already on the draft is not replaced or removed that way either.
  const drafted = { stock_op: { kind: 'move', direction: 'return', inputs: [{ lot: 'L13' }] }, trust_warnings: ['kept'] };
  const again = await call('update_draft', { stock_op: null, category_code: 5010, note: 'x' }, user, drafted);
  assert.deepEqual(again.ctx.draft.stock_op, drafted.stock_op);
  assert.equal(again.ctx.draft.category_code, undefined);
  assert.equal(again.result.current_draft.trust_warnings, undefined);

  // Same for a general user; every other category still goes through.
  const general = await call('update_draft', { category_code: '5010', stock_op: { kind: 'split' } }, other);
  assert.deepEqual(general.ctx.draft, {});
  const plain = await call('update_draft', { category_code: '5000', amount: 5 }, other);
  assert.deepEqual(plain.ctx.draft, { category_code: '5000', amount: 5 });
  assert.equal(plain.result.note, undefined);
});

test('update_draft: the lot block is in the gem schema only, and a lot purchase filled that way is ready for its card', async () => {
  const itemProps = (def) => def.parameters.properties.items.items.properties;
  assert.equal(itemProps(updateDraft.definition).lot, undefined);
  assert.deepEqual(TOOLS.find((t) => t.function.name === 'update_draft').function, updateDraft.definition);
  const lotBlock = itemProps(updateDraft.nicheDefinitions.gems).lot;
  assert.deepEqual(lotBlock.required, ['carats', 'price', 'pricing_basis']);
  for (const k of ['code', 'carats', 'pieces', 'form', 'variety', 'treatment', 'price', 'pricing_basis', 'weight_estimated']) assert.ok(lotBlock.properties[k], `lot.${k} is not in the schema`);

  const { ctx } = await call('update_draft', {
    transaction_type: 'bill_received', counterparty_name: h.N.SUPPLIER, payment_terms: 'net_0', currency: 'THB',
    items: [{ lot: { carats: 10000, form: 'rough', variety: 'sapphire', price: 150000, pricing_basis: 'per_kg' } }],
  }, user, { counterparty_contact_skipped: true });
  assert.equal(await prepare(user, ctx.draft), null);
  await applyDefaults(user, ctx.draft);
  assert.deepEqual(validateDraft(ctx.draft), []);
  assert.equal(await readinessError(user, ctx.draft, () => client), null);
  assert.equal(ctx.draft.amount, 300000);
  assert.deepEqual(ctx.draft.items[0], { description: 'sapphire rough', qty: 1, rate: 300000, lot: { carats: 10000, form: 'rough', variety: 'sapphire', price: 150000, pricing_basis: 'per_kg' } });
});

test('update_stock_op needs a kind, and only a kind it knows', async () => {
  const none = await call('update_stock_op', { inputs: [{ lot: 'L13' }] });
  assert.equal(none.result.ok, false);
  assert.match(none.result.error, /Say what is being done first: kind = split, merge, transform, move, write_off, undo/);
  assert.deepEqual(none.ctx.draft, {});
  const bad = await call('update_stock_op', { kind: 'sell', inputs: [{ lot: 'L13' }] });
  assert.match(bad.result.error, /kind "sell" is not a stock operation.*Buying or selling a lot is update_draft with a lot block/);
  assert.deepEqual(bad.ctx.draft, {});
});

test('update_stock_op merges into the operation, replaces lists whole, removes with null', async () => {
  const ctx = h.ctxFor(user, { note: 'kept', trust_warnings: ['server'] });
  let r = await executeTool('update_stock_op', { kind: 'Move', direction: 'out_memo', inputs: [{ lot: 'L16', carats: 3 }], holder: 'Jameel', due_date: '2027-01-31' }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.current_draft, { note: 'kept', stock_op: { kind: 'move', direction: 'out_memo', inputs: [{ lot: 'L16', carats: 3 }], holder: 'Jameel', due_date: '2027-01-31' } });
  assert.deepEqual(ctx.draft.trust_warnings, ['server']);

  r = await executeTool('update_stock_op', { memo_price_per_ct: 30000, inputs: [{ lot: 'L16', carats: 2 }], due_date: null, amount: 500, counterparty_name: 'Jameel' }, ctx);
  assert.deepEqual(ctx.draft.stock_op, { kind: 'move', direction: 'out_memo', inputs: [{ lot: 'L16', carats: 2 }], holder: 'Jameel', memo_price_per_ct: 30000 });
  assert.match(r.note, /Not applied: amount, counterparty_name are not part of a stock operation \(money fields go through update_draft\)/);
  assert.equal(ctx.draft.amount, undefined);
  assert.equal(await prepare(user, ctx.draft), null);

  // Another kind is another operation: nothing of the old one stays.
  r = await executeTool('update_stock_op', { kind: 'write_off', reason: 'lost' }, ctx);
  assert.deepEqual(ctx.draft.stock_op, { kind: 'write_off', reason: 'lost' });
  r = await executeTool('update_stock_op', { clear: true }, ctx);
  assert.deepEqual(r, { ok: true, current_draft: { note: 'kept' } });
  assert.equal('stock_op' in ctx.draft, false);
});

const cutting = { kind: 'transform', job: 'cutting', inputs: [{ lot: 'L13' }], outputs: [{ carats: 30, pieces: 42 }] };
const cash = { transaction_type: 'cash', direction: 'expense', counterparty_name: 'Lek' };

test('update_stock_op: the fee amount the server derives follows the rate and the weights, and "no fee" removes it', async () => {
  const ctx = h.ctxFor(user, { ...cash });
  const call2 = (args) => executeTool('update_stock_op', args, ctx);

  await call2({ ...cutting, fee_basis: 'per_ct', fee_rate: 80 });
  assert.deepEqual([ctx.draft.amount, ctx.draft.stock_op.fee_derived], [2400, true]);
  await call2({ outputs: [{ carats: 40, pieces: 50 }] }); // heavier: re-derived
  assert.equal(ctx.draft.amount, 3200);
  await call2({ fee_rate: 90 });
  assert.equal(ctx.draft.amount, 3600);
  await call2({ fee_basis: 'per_piece', fee_rate: 50 });
  assert.equal(ctx.draft.amount, 2500);
  await call2({ outputs: [{ carats: 40 }] }); // no piece count any more: nothing to work it out from, so it must not stay
  assert.equal(ctx.draft.amount, undefined);
  assert.equal(ctx.draft.stock_op.fee_derived, undefined);
  await call2({ fee_basis: 'fixed', fee_rate: 5000 });
  assert.equal(ctx.draft.amount, 5000);
  await call2({ fee_rate: null, fee_basis: null }); // no rate: no fee
  assert.deepEqual([ctx.draft.amount, ctx.draft.stock_op.fee_derived, ctx.draft.stock_op.fee_rate], [undefined, undefined, undefined]);

  await call2({ fee_basis: 'per_ct', fee_rate: 80 });
  assert.equal(ctx.draft.amount, 3200);
  const r = await call2({ no_fee: true });
  assert.equal(r.ok, true);
  assert.deepEqual([ctx.draft.amount, ctx.draft.stock_op.fee_rate, ctx.draft.stock_op.fee_basis, ctx.draft.stock_op.fee_derived], [undefined, undefined, undefined, undefined]);
  assert.equal(ctx.draft.transaction_type, 'cash'); // the rest of the draft is the model's

  // A sum the trader stated is theirs: the rate and the weights never move it, "no fee" does remove it.
  const stated = h.ctxFor(user, { ...cash, amount: 2400 });
  await executeTool('update_stock_op', { ...cutting, fee_basis: 'per_ct', fee_rate: 80 }, stated);
  assert.equal(stated.draft.stock_op.fee_derived, undefined);
  await executeTool('update_stock_op', { outputs: [{ carats: 40 }] }, stated);
  assert.equal(stated.draft.amount, 2400);
  await executeTool('update_stock_op', { no_fee: true }, stated);
  assert.equal(stated.draft.amount, undefined);

  // The model cannot mark an amount as derived or as stated.
  const forged = await executeTool('update_stock_op', { fee_derived: true }, h.ctxFor(user, { ...cash, stock_op: { ...cutting } }));
  assert.match(forged.note, /Not applied: fee_derived/);

  // A different kind starts afresh, derived fee and all.
  const moved = h.ctxFor(user, { ...cash });
  await executeTool('update_stock_op', { ...cutting, fee_basis: 'per_ct', fee_rate: 80 }, moved);
  await executeTool('update_stock_op', { kind: 'move', direction: 'return', inputs: [{ lot: 'L13' }] }, moved);
  assert.equal(moved.draft.amount, undefined);
  assert.equal(moved.draft.category_code, undefined);

  // The trader's own figure through update_draft: from then on it is not re-derived.
  const own = h.ctxFor(user, { ...cash });
  await executeTool('update_stock_op', { ...cutting, fee_basis: 'per_ct', fee_rate: 80 }, own);
  await executeTool('update_draft', { amount: 2400 }, own); // the same figure again: still the server's
  assert.equal(own.draft.stock_op.fee_derived, true);
  await executeTool('update_draft', { amount: 2500 }, own);
  assert.equal(own.draft.stock_op.fee_derived, undefined);
  await executeTool('update_stock_op', { outputs: [{ carats: 40 }] }, own);
  assert.equal(own.draft.amount, 2500);
});

test('update_stock_op: clear drops the operation and everything it put on the draft', async () => {
  // Fee worked out from the rate: the amount, the category and the money that was only the fee's go.
  const ctx = h.ctxFor(user, { ...cash, currency: 'THB', payment_account_id: 7 });
  await executeTool('update_stock_op', { ...cutting, fee_basis: 'per_ct', fee_rate: 80 }, ctx);
  ctx.draft.category_code = '5010'; // the lot gate's part
  ctx.draft.confirmation_pending = 'sig';
  const r = await executeTool('update_stock_op', { clear: true }, ctx);
  assert.deepEqual(r, { ok: true, current_draft: {} });
  assert.deepEqual(ctx.draft, {});
  // A stated fee too: it only ever belonged to this operation.
  const stated = await call('update_stock_op', { clear: true }, user, { ...cash, amount: 2400, category_code: '5010', stock_op: { ...cutting } });
  assert.deepEqual(stated.ctx.draft, {});
  // No money on the draft: only the operation (and what the gate set) goes.
  const bare = await call('update_stock_op', { clear: true }, user, { note: 'kept', category_code: '5010', stock_op: { ...cutting }, trust_warnings: ['x'] });
  assert.deepEqual(bare.ctx.draft, { note: 'kept' });
  const other5000 = await call('update_stock_op', { clear: true }, user, { category_code: '5000', stock_op: { ...cutting } });
  assert.deepEqual(other5000.ctx.draft, { category_code: '5000' });
  // The fee category also leaves with a change of kind, and stays on the same transform.
  const kept = await call('update_stock_op', { note: 'second cut' }, user, { category_code: '5010', amount: 2400, stock_op: { ...cutting } });
  assert.equal(kept.ctx.draft.category_code, '5010');
});

test('update_stock_op: it refuses to join a draft that is another entry', async () => {
  const lunch = { transaction_type: 'cash', direction: 'expense', amount: 250, currency: 'THB', category_code: '5100', description: 'lunch' };
  const r = await call('update_stock_op', { ...cutting, fee_basis: 'per_ct', fee_rate: 80 }, user, { ...lunch });
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /already holds another entry \(250 THB, category 5100, "lunch"\).*save it first.*or discard it \(cancel_transaction\)/);
  assert.deepEqual(r.ctx.draft, lunch); // not turned into a capitalised cutting fee
  for (const other of [
    { transaction_type: 'invoice_issued', amount: 900 }, { direction: 'income', amount: 10 }, { items: [{ description: 'x', rate: 5 }] },
    { transaction_type: 'cash', direction: 'expense', amount: 250 }, // kind is not a transform: a split moves no money
  ]) {
    const refused = await call('update_stock_op', { kind: 'split', inputs: [{ lot: 'L13' }], outputs: [{ carats: 1 }] }, user, { ...other });
    assert.equal(refused.result.ok, false, JSON.stringify(other));
  }
  // The fee of this work itself is welcome before or after: cash or bill, expense, no category of its own, the amount perhaps already said.
  for (const mine of [{}, { ...cash }, { ...cash, amount: 2400 }, { transaction_type: 'bill_received', direction: 'expense', counterparty_name: 'Lek', amount: 2400, category_code: '5010' }]) {
    const ok = await call('update_stock_op', { ...cutting }, user, { ...mine });
    assert.equal(ok.result.ok, true, JSON.stringify(mine));
  }
  // An operation already on the draft is edited, whatever else the draft holds.
  const again = await call('update_stock_op', { note: 'x' }, user, { ...cash, stock_op: { ...cutting } });
  assert.equal(again.result.ok, true);
});

test('a cutting with its fee, filled over two tools, is ready for its card', async () => {
  const wallet = (await call('list_user_accounts', {})).result.accounts[0].id;
  const ctx = h.ctxFor(user, { wallet_options: [wallet] });
  await executeTool('update_stock_op', { kind: 'transform', job: 'cutting', inputs: [{ lot: 'L13' }], outputs: [{ carats: 30, pieces: 42 }], fee_basis: 'per_ct', fee_rate: 80 }, ctx);
  await executeTool('update_draft', { transaction_type: 'cash', direction: 'expense', counterparty_name: 'Lek', currency: 'THB', payment_account_id: wallet }, ctx);
  assert.equal(await prepare(user, ctx.draft), null);
  assert.equal(ctx.draft.amount, 2400);
  ctx.draft.category_code = '5010'; // the lot gate's part
  await applyDefaults(user, ctx.draft);
  assert.deepEqual(validateDraft(ctx.draft), []);
  assert.equal(await readinessError(user, ctx.draft, () => client), null);
});

// ── questions ────────────────────────────────────────────────────────

test('query_lots: what is on record, where, at what cost', async () => {
  const { result } = await call('query_lots', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.lots.map((l) => l.code).sort(), ['L13', 'L14', 'L16']);
  assert.deepEqual(result.totals, { lots: 3, carats: 208, cost: 475741.94, cost_currency: 'THB' });
  assert.deepEqual(result.lots.find((l) => l.code === 'L13'), {
    code: 'L13', what: 'blue sapphire rough', carats: 120, cost: 270000, cost_per_ct: 2250, place: 'out for work', holder: 'Lek', form: 'rough',
  });
  assert.deepEqual(result.lots.find((l) => l.code === 'L16'), {
    code: 'L16', what: 'blue sapphire cut', carats: 8, pieces: 5, cost: 175741.94, cost_per_ct: 21967.74, place: 'in stock', form: 'cut', treatment: 'H',
  });

  const names13 = async (args) => (await call('query_lots', args)).result.lots.map((l) => l.code).sort();
  assert.deepEqual(await names13({ place: 'work' }), ['L13']);
  assert.deepEqual(await names13({ holder: 'lek' }), ['L13']);
  assert.deepEqual(await names13({ form: 'cut' }), ['L16']);
  assert.deepEqual(await names13({ search: 'l14' }), ['L14']);
  assert.deepEqual(await names13({ include_empty: true }), ['L12', 'L13', 'L14', 'L16']);
  const all = (await call('query_lots', { include_empty: true })).result;
  assert.equal(all.lots.find((l) => l.code === 'L12').empty, true);

  const one = (await call('query_lots', { limit: 1 })).result;
  assert.equal(one.lots.length, 1);
  assert.equal(one.totals.lots, 3);
  assert.match(one.note, /2 more lot\(s\) match and are counted in totals but not listed/);

  assert.deepEqual((await call('query_lots', { place: 'memo' })).result, { ok: true, message: 'no_lots', lots: [], totals: { lots: 0, carats: 0, cost: 0, cost_currency: 'THB' } });
});

test('query_lot_history: what happened to a lot, what it came from and what it became', async () => {
  const { result } = await call('query_lot_history', { lot: ' l13 ' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lot, { code: 'L13', what: 'blue sapphire rough', carats: 120, cost: 270000, cost_per_ct: 2250, place: 'out for work', holder: 'Lek', form: 'rough' });
  assert.equal(result.cost_currency, 'THB');
  assert.deepEqual(result.operations.map((o) => o.kind).sort(), ['move', 'split']);
  const sent = result.operations.find((o) => o.kind === 'move');
  assert.equal(sent.direction, 'out_work');
  assert.equal(sent.holder, 'Lek');
  assert.match(sent.reference, /^BPL-/);
  assert.equal(sent.status, undefined); // posted is the normal case and is not said
  assert.deepEqual(result.came_from.map((x) => x.code), ['L12']);
  assert.deepEqual(result.became, []);
  assert.deepEqual(result.certificates, []);

  const parent = (await call('query_lot_history', { lot: 'L12' })).result;
  assert.equal(parent.lot.empty, true);
  assert.deepEqual(parent.became.map((x) => x.code).sort(), ['L13', 'L14']);
  assert.deepEqual(parent.came_from, []);

  assert.deepEqual((await call('query_lot_history', { lot: 'L99' })).result, { ok: true, message: 'no_such_lot', lot: 'L99' });
  assert.deepEqual((await call('query_lot_history', {})).result, { ok: true, message: 'no_such_lot', lot: '' });
});

// ── set_lot_details ──────────────────────────────────────────────────

test('set_lot_details changes descriptive fields only, and says what changed', async () => {
  const { result } = await call('set_lot_details', { lot: 'l16', grade: ' AA ', origin: 'Sri Lanka', ask_per_ct: '30,000' });
  assert.deepEqual(result, { ok: true, lot: 'L16', changed: { grade: { from: null, to: 'AA' }, origin: { from: null, to: 'Sri Lanka' }, ask_per_ct: { from: null, to: 30000 } } });
  const lot = await store.getLot(user.id, 'L16');
  assert.deepEqual([lot.grade, lot.origin, lot.ask_per_ct, lot.treatment], ['AA', 'Sri Lanka', 30000, 'H']);

  const same = (await call('set_lot_details', { lot: 'L16', grade: 'AA' })).result;
  assert.deepEqual(same, { ok: true, lot: 'L16', changed: {}, note: 'Nothing changed: the lot already says that.' });
  const cleared = (await call('set_lot_details', { lot: 'L16', origin: null, grade: 'A' })).result;
  assert.deepEqual(cleared.changed, { origin: { from: 'Sri Lanka', to: null }, grade: { from: 'AA', to: 'A' } });
  assert.equal((await store.getLot(user.id, 'L16')).origin, null);
});

test('set_lot_details does not change the treatment, who says so, the tax flag or the supplier document', async () => {
  const wants = {
    treatment: /changes only through an operation \(update_stock_op, e\.g\. a transform with job heating/,
    treatment_source: /Who says what the treatment is stays/,
    vat_exempt: /tax matter for the accountant/,
    supplier_doc: /tax matter for the accountant/,
  };
  const before = await store.getLot(user.id, 'L16');
  for (const [key, re] of Object.entries(wants)) {
    const { result } = await call('set_lot_details', { lot: 'L16', grade: 'B', [key]: key === 'treatment' ? 'H-FH' : key === 'treatment_source' ? 'lab' : true });
    assert.equal(result.ok, false);
    assert.match(result.error, re);
    assert.match(result.error, /Nothing was changed\.$/);
  }
  const after = await store.getLot(user.id, 'L16');
  assert.deepEqual([after.treatment, after.treatment_source, after.vat_exempt, after.supplier_doc, after.grade], [before.treatment, before.treatment_source, before.vat_exempt, before.supplier_doc, before.grade]);
  assert.equal(after.treatment, 'H');
  // Not even offered to the model.
  const schema = toolsFor(user).find((t) => t.function.name === 'set_lot_details').function.parameters.properties;
  for (const key of Object.keys(wants)) assert.equal(schema[key], undefined, key);
});

test('set_lot_details: no flag or loose figure becomes a price, descriptions are capped, a report is not added twice', async () => {
  const refused = async (args, re) => {
    const { result } = await call('set_lot_details', { lot: 'L16', ...args });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.error, re);
  };
  await refused({ ask_per_ct: true }, /ask_per_ct true must be a price per carat more than 0/);
  await refused({ bottom_per_ct: [5] }, /bottom_per_ct \[5\] must be a price per carat/);
  await refused({ bottom_per_ct: Infinity }, /must be a price per carat/);
  await refused({ grade: { a: 1 } }, /grade must be a word or a few words/);
  await refused({ description: 'x'.repeat(501) }, /description is 501 characters; at most 500/);
  await refused({ colour: 'x'.repeat(201) }, /colour is 201 characters; at most 200/);
  await refused({ certificate: { lab: 'GIT', stated_carats: true } }, /stated_carats true must be more than 0/);
  await refused({ certificate: { lab: ['GIT'] } }, /certificate\.lab must be text/);
  assert.equal((await store.getLot(user.id, 'L16')).ask_per_ct, 30000);
  const ok = await call('set_lot_details', { lot: 'L16', description: 'x'.repeat(500), bottom_per_ct: '25,000' });
  assert.equal(ok.result.ok, true);
  assert.equal((await store.getLot(user.id, 'L16')).bottom_per_ct, 25000);
  await call('set_lot_details', { lot: 'L16', description: null });

  const cert = { lab: 'GRS', report_no: 'GRS2026-1', stated_carats: '8 ct' };
  assert.equal((await call('set_lot_details', { lot: 'L14', certificate: cert })).result.ok, true);
  const twice = await call('set_lot_details', { lot: 'L14', certificate: { ...cert, lab: 'grs', report_no: ' grs2026-1 ' }, grade: 'C' });
  assert.equal(twice.result.ok, false);
  assert.match(twice.result.error, /Lot L14 already has the GRS report GRS2026-1\. It was not added twice\. Nothing was changed\.$/);
  assert.equal((await store.getLot(user.id, 'L14')).grade, null); // nothing else of that call was saved either
  assert.equal((await store.listCertificates((await store.getLot(user.id, 'L14')).id)).filter((c) => c.lab === 'GRS').length, 1);
  // Another report, or the same number from another lab, is fine; so is a report with no number.
  assert.equal((await call('set_lot_details', { lot: 'L14', certificate: { lab: 'GRS', report_no: 'GRS2026-2' } })).result.ok, true);
  assert.equal((await call('set_lot_details', { lot: 'L14', certificate: { lab: 'AIGS', report_no: 'GRS2026-1' } })).result.ok, true);
  assert.equal((await call('set_lot_details', { lot: 'L14', certificate: { lab: 'AIGS' } })).result.ok, true);
  assert.equal((await call('set_lot_details', { lot: 'L14', certificate: { lab: 'AIGS' } })).result.ok, true);
});

test('set_lot_details refuses weight, pieces, cost, code, form and place, and changes nothing then', async () => {
  for (const key of ['carats', 'pieces', 'cost', 'code', 'form', 'location', 'holder', 'status', 'weight_estimated', 'erpnext_batch']) {
    const { result } = await call('set_lot_details', { lot: 'L16', grade: 'B', [key]: key === 'code' ? 'L99' : 1 });
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(`^${key} cannot be changed here\\. .*only through an operation.*Nothing was changed\\.$`));
  }
  const lot = await store.getLot(user.id, 'L16');
  assert.deepEqual([lot.code, lot.carats, lot.pieces, lot.cost, lot.form, lot.location, lot.grade], ['L16', 8, 5, 175741.94, 'cut', 'stores', 'A']);

  const refused = async (args, re) => {
    const { result } = await call('set_lot_details', args);
    assert.equal(result.ok, false);
    assert.match(result.error, re);
  };
  await refused({ grade: 'B' }, /^Which lot\?/);
  await refused({ lot: 'L16' }, /^Nothing to change/);
  await refused({ lot: 'L404', grade: 'B' }, /^There is no lot L404 .*Nothing was changed\.$/);
  await refused({ lot: 'L16', ask_per_ct: 'cheap', grade: 'B' }, /Nothing was changed\.$/);
  await refused({ lot: 'L16', ask_per_ct: -1, grade: 'B' }, /Nothing was changed\.$/);
  await refused({ lot: 'L16', price_currency: 'baht', grade: 'B' }, /Nothing was changed\.$/);
  await refused({ lot: 'L16', certificate: { report_no: 'X1' }, grade: 'B' }, /Nothing was changed\.$/);
  await refused({ lot: 'L16', certificate: { lab: 'GIA', carats: 9 }, grade: 'B' }, /Nothing was changed\.$/);
  assert.equal((await store.getLot(user.id, 'L16')).grade, 'A');
});

test('set_lot_details adds a lab certificate; the report never changes the weight', async () => {
  const { result } = await call('set_lot_details', { lot: 'L16', certificate: { lab: 'GIT', report_no: 'G-1001', report_date: '2026-10-30', stated_carats: 7.98 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, {});
  assert.deepEqual(result.certificate_added, { lab: 'GIT', report_no: 'G-1001', report_date: '2026-10-30', stated_carats: 7.98 });
  assert.match(result.note, /The report states 7\.98 ct but the lot holds 8 ct\. The lot's weight was NOT changed/);
  assert.equal((await store.getLot(user.id, 'L16')).carats, 8);
  const history = (await call('query_lot_history', { lot: 'L16' })).result;
  assert.deepEqual(history.certificates, [{ lab: 'GIT', report_no: 'G-1001', report_date: '2026-10-30', stated_carats: 7.98 }]);
});

// ── set_gem_settings ─────────────────────────────────────────────────

test('set_gem_settings: cannot switch lot tracking on for an account that does not have it, and says nothing that invites a try', async () => {
  const fresh = await h.addUser({ niche: null });
  // The model of such an account is not offered the tool, and the call is refused as an unknown tool.
  assert.ok(!names(toolsFor(fresh)).includes('set_gem_settings'));
  const viaTool = await call('set_gem_settings', { enabled: true }, fresh);
  assert.deepEqual(viaTool.result, { ok: false, error: 'Unknown tool: set_gem_settings' });
  // Reached directly all the same: refused, nothing written, no hint how to get it on.
  const direct = await require('../src/tools/set-gem-settings').execute({ enabled: true, cost_method: 'weight' }, h.ctxFor(fresh));
  assert.deepEqual(direct, { ok: false, error: 'Lot tracking is not available on this account. Nothing was changed.' });
  assert.doesNotMatch(direct.error, /switch|enable|set_gem|ask|call/i);
  assert.deepEqual(await row(fresh.id), { niche: null, lot_cost_method: null });
  for (const args of [{}, { enabled: 'yes' }, { cost_method: 'fifo' }]) {
    assert.equal((await require('../src/tools/set-gem-settings').execute(args, h.ctxFor(fresh))).ok, false);
  }
  assert.deepEqual(await row(fresh.id), { niche: null, lot_cost_method: null });
  // The gem trader's own tool says it plainly in its description too.
  const description = toolsFor(user).find((t) => t.function.name === 'set_gem_settings').function.description;
  assert.match(description, /cannot be switched back on from chat/);
});

test('set_gem_settings: the cost method before any lot is recorded; off when no stones are on record; true changes nothing', async () => {
  const fresh = await h.addUser({});
  const refused = async (args, re) => {
    const { result } = await call('set_gem_settings', args, fresh);
    assert.equal(result.ok, false);
    assert.match(result.error, re);
  };
  await refused({}, /^Nothing to set/);
  await refused({ enabled: 'yes' }, /^enabled must be true or false/);
  await refused({ cost_method: 'fifo' }, /^cost_method must be value or weight/);
  await refused({ cost_method: ['weight'] }, /^cost_method must be value or weight/);
  assert.deepEqual(await row(fresh.id), { niche: 'gems', lot_cost_method: null });

  assert.deepEqual((await call('set_gem_settings', { enabled: true }, fresh)).result, { ok: true, lot_tracking: true, cost_method: 'value' });
  const method = await call('set_gem_settings', { cost_method: 'Weight' }, fresh);
  assert.deepEqual(method.result, { ok: true, lot_tracking: true, cost_method: 'weight' });
  assert.deepEqual(await row(fresh.id), { niche: 'gems', lot_cost_method: 'weight' });

  const off = await call('set_gem_settings', { enabled: false }, method.ctx.user);
  assert.deepEqual(off.result, { ok: true, lot_tracking: false, cost_method: null, note: 'Lot tracking is now off for this account.' });
  assert.deepEqual(await row(fresh.id), { niche: null, lot_cost_method: 'weight' });
  assert.deepEqual(toolsFor(off.ctx.user), TOOLS);
  // And it stays off: nothing in chat switches it back on.
  assert.equal((await call('set_gem_settings', { enabled: true }, off.ctx.user)).result.ok, false);
  assert.equal((await row(fresh.id)).niche, null);
});

test('set_gem_settings: not off while stones are on record, and the cost method is fixed once a lot has been sorted or worked on', async () => {
  const off = await call('set_gem_settings', { enabled: false });
  assert.equal(off.result.ok, false);
  assert.match(off.result.error, /cannot be switched off while there are stones on record: 3 lot\(s\), 208 ct \(.*L13.*\)\. They have to be sold or written off first\./);
  const method = await call('set_gem_settings', { cost_method: 'weight' });
  assert.equal(method.result.ok, false);
  assert.match(method.result.error, /The way cost is shared cannot change any more: 1 sorting \/ cutting operation\(s\) are already recorded with "value"/);
  assert.equal((await row(user.id)).niche, 'gems');
  assert.equal(user.niche, 'gems');
  // Saying what is already so is not a change.
  assert.deepEqual((await call('set_gem_settings', { enabled: true, cost_method: 'value' })).result, { ok: true, lot_tracking: true, cost_method: 'value' });
  // A purchase shares no cost: it does not fix the method.
  const buyer = await h.addUser({});
  await h.recordPosted(buyer, h.resolvedOp({ kind: 'buy', outputs: [h.output({ code: 'B1', carats: 5, cost: 500 })] }));
  const buyerMethod = await call('set_gem_settings', { cost_method: 'weight' }, buyer);
  assert.deepEqual(buyerMethod.result, { ok: true, lot_tracking: true, cost_method: 'weight' });
  assert.equal((await row(buyer.id)).lot_cost_method, 'weight');
});

test('set_gem_settings: an unfinished operation blocks switching off and counts for the cost method', async () => {
  const trader = await h.addUser({});
  const op = h.resolvedOp({ kind: 'split', inputs: [], outputs: [h.output({ code: 'L1', carats: 10, cost: 100 })] });
  const begun = await store.beginOp(trader, { op });
  const off = await call('set_gem_settings', { enabled: false }, trader);
  assert.equal(off.result.ok, false);
  assert.equal(off.result.error, `Stock operation ${begun.reference} is not finished. Finish it (retry_stock_op) or take it back before switching lot tracking off.`);
  const method = await call('set_gem_settings', { cost_method: 'weight' }, trader);
  assert.match(method.result.error, /cannot change any more: 1 sorting \/ cutting operation/);
  assert.equal((await row(trader.id)).niche, 'gems');
});

// ── questions: strict input, limits, whose lots ──────────────────────

test('query_lots: an invalid place or form is an error, the limit is clamped, loose input is refused', async () => {
  const refused = async (args, re) => {
    const { result } = await call('query_lots', args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.error, re);
    assert.equal(result.lots, undefined);
  };
  await refused({ place: 'vault' }, /place "vault" is not one of stores, work, memo\. Pass one of these, or leave it out for all/);
  await refused({ place: ['work'] }, /place .* is not one of/);
  await refused({ form: 'faceted' }, /form "faceted" is not one of rough, preform, cut, cabochon, bead/);
  await refused({ holder: { name: 'Lek' } }, /holder must be a word/);
  await refused({ search: true }, /search must be a word/);
  await refused({ limit: 'many' }, /limit must be a number/);
  await refused({ limit: true }, /limit must be a number/);

  const rows = async (args) => (await call('query_lots', args)).result;
  assert.equal((await rows({ limit: 0 })).lots.length, 1);
  assert.equal((await rows({ limit: -7 })).lots.length, 1);
  assert.equal((await rows({ limit: '2' })).lots.length, 2);
  assert.equal((await rows({ limit: 1e9 })).lots.length, 3);
  assert.equal((await rows({ limit: 2.9 })).lots.length, 2);
  assert.equal((await rows({ place: '' })).lots.length, 3); // blank means not said
  // However few rows come back, the totals are those of every match.
  assert.deepEqual((await rows({ limit: 1 })).totals, { lots: 3, carats: 208, cost: 475741.94, cost_currency: 'THB' });
  assert.deepEqual((await rows({ place: 'work', limit: 1 })).totals, { lots: 1, carats: 120, cost: 270000, cost_currency: 'THB' });
});

test('query_lots and query_lot_history never return another trader\'s lots', async () => {
  const rival = await h.addUser({});
  // The rival's L13 is not ours; their R1 is theirs alone.
  await h.recordPosted(rival, h.resolvedOp({ kind: 'buy', counterparty: 'Rival Gems', outputs: [
    h.output({ code: 'L13', carats: 7, cost: 7000, attrs: { variety: 'ruby', colour: 'red' } }),
    h.output({ code: 'R1', carats: 3, cost: 300, attrs: { variety: 'spinel' } }),
  ] }));
  const mine = (await call('query_lots', { include_empty: true })).result;
  assert.deepEqual(mine.lots.map((l) => l.code).sort(), ['L12', 'L13', 'L14', 'L16']);
  assert.equal(mine.lots.find((l) => l.code === 'L13').carats, 120);
  assert.deepEqual((await call('query_lots', { search: 'ruby' })).result.lots, []);
  assert.deepEqual((await call('query_lots', { search: 'R1' })).result.lots, []);
  assert.equal((await call('query_lots', {})).result.totals.lots, 3);

  const theirs = (await call('query_lots', {}, rival)).result;
  assert.deepEqual(theirs.lots.map((l) => l.code).sort(), ['L13', 'R1']);
  assert.deepEqual(theirs.totals, { lots: 2, carats: 10, cost: 7300, cost_currency: 'THB' });

  assert.deepEqual((await call('query_lot_history', { lot: 'R1' })).result, { ok: true, message: 'no_such_lot', lot: 'R1' });
  const sameCode = (await call('query_lot_history', { lot: 'L13' })).result;
  assert.equal(sameCode.lot.carats, 120);
  assert.deepEqual(sameCode.operations.map((o) => o.kind).sort(), ['move', 'split']);
  const rivalCode = (await call('query_lot_history', { lot: 'L13' }, rival)).result;
  assert.deepEqual([rivalCode.lot.carats, rivalCode.lot.what], [7, 'red ruby rough']);
  assert.deepEqual(rivalCode.operations.map((o) => o.kind), ['buy']);
  assert.deepEqual((await call('query_lot_history', { lot: 'R1' }, rival)).result.lot.carats, 3);
  // Loose input is not a code.
  assert.deepEqual((await call('query_lot_history', { lot: true })).result, { ok: true, message: 'no_such_lot', lot: '' });
  assert.deepEqual((await call('query_lot_history', { lot: ['L13'] })).result, { ok: true, message: 'no_such_lot', lot: '' });
});

// ── through the tools: the card, the yes, the save ───────────────────

test('a lot purchase through the tools: request_confirmation, the trader\'s yes on a later turn, save_transaction', async () => {
  const ctx = h.ctxFor(user, { counterparty_contact_skipped: true });
  await executeTool('update_draft', {
    transaction_type: 'bill_received', counterparty_name: h.N.SUPPLIER, payment_terms: 'net_0', currency: 'THB',
    items: [{ lot: { carats: 10, form: 'rough', variety: 'ruby', colour: 'red', origin: 'Mong Hsu', treatment: 'H', price: 1000, pricing_basis: 'per_ct' } }],
  }, ctx);

  // No card yet: nothing is saved, whatever the model calls.
  const early = await executeTool('save_transaction', {}, ctx);
  assert.equal(early.ok, false);
  assert.match(early.error, /No confirmation card has been sent/);

  const asked = await executeTool('request_confirmation', {}, ctx);
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.equal(asked.card.lines[1], 'Amount: 10,000 THB');
  assert.match(asked.card.lines[2], /^- L\d+ red ruby rough: 10 ct, cost 10,000 THB = 1,000 per ct$/);
  assert.equal(asked.card.lines[3], '  Details: origin Mong Hsu, treatment H');
  const code = asked.card.lines[2].match(/^- (L\d+) /)[1];
  assert.equal(await store.getLot(user.id, code), null, 'a card alone saves nothing');
  assert.equal(ctx.confirmationRequested, true);

  // Same turn: the card does not authorise itself.
  const sameTurn = await executeTool('save_transaction', {}, ctx);
  assert.equal(sameTurn.ok, false);
  assert.equal(await store.getLot(user.id, code), null);

  // The trader answers on the next turn (conversation.handle promotes the signature); a change in between voids it.
  ctx.draft.confirmation_pending = ctx.draft.confirmation_sig;
  const changed = h.ctxFor(user, JSON.parse(JSON.stringify(ctx.draft)));
  changed.draft.items[0].lot.grade = 'AA';
  const refused = await executeTool('save_transaction', {}, changed);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /changed after the confirmation card was sent/);
  assert.equal(await store.getLot(user.id, code), null);

  const saved = await executeTool('save_transaction', {}, ctx);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.lots[0].code, code);
  const lot = await store.getLot(user.id, code);
  assert.deepEqual([lot.carats, lot.cost, lot.form, lot.origin, lot.treatment, lot.status], [10, 10000, 'rough', 'Mong Hsu', 'H', 'active']);
  assert.deepEqual(ctx.draft, {}); // the draft is spent
  // And the same card cannot be saved twice.
  assert.equal((await executeTool('save_transaction', {}, ctx)).ok, false);
});
