/**
 * The ERPNext side of gem lots below the runner: names and masters (src/lots/erp.js), the Stock
 * Entry builders (src/lots/stock-entry.js) posted to the fake ERPNext, reading stock back, the
 * check before a save, and what saveDraft's `opts` add to a document (src/erp-sync).
 *
 * The fake starts WITHOUT the gem masters here: ensureSetup has to make them. Steps share state
 * and run in order.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext } = require('./fake-erpnext');
const h = require('./lots-helpers');
const lots = require('../src/lots');
const lotErp = require('../src/lots/erp');
const entries = require('../src/lots/stock-entry');
const { saveDraft } = require('../src/erp-sync');

const { N, TODAY, COMPANY } = h;
const STOCK_LOSS = 'Stock Loss - TC';
const erp = new FakeErpNext();
let user; let client; let acc; let ctx;
const ids = {};

before(async () => {
  erp.install();
  await h.freshDb();
  user = await h.addUser();
  client = h.clientFor();
});

const posted = (doctype, from = 0) => erp.calls.slice(from).filter((c) => c.method === 'POST' && decodeURIComponent(c.url).endsWith(`/api/resource/${doctype}`)).length;
const posts = (from = 0) => erp.calls.slice(from).filter((c) => c.method === 'POST').length;
const post = (doc) => client.createResource('Stock Entry', doc).then((r) => r.data);
function gl(voucherNo) {
  const out = {};
  for (const g of erp.all('GL Entry').filter((x) => x.voucher_no === voucherNo)) {
    out[g.account] = Math.round(((out[g.account] || 0) + g.debit - g.credit) * 100) / 100;
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}
async function withFetch(hook, fn) {
  const real = global.fetch;
  global.fetch = (url, opts = {}) => hook(real, url, opts);
  try { return await fn(); } finally { global.fetch = real; }
}

// ── names ──────────────────────────────────────────────────────────────

test('names: items, batches and warehouses carry the company abbreviation', async () => {
  assert.equal(lotErp.itemCode('rough', 'TC'), 'GEM-ROUGH-TC');
  assert.equal(lotErp.itemCode('cut', 'TC'), 'GEM-CUT-TC');
  assert.throws(() => lotErp.itemCode('polished', 'TC'), /Unknown gem item kind/);
  assert.equal(lotErp.batchName('L12', 0, 'TC'), 'L12-TC');
  assert.equal(lotErp.batchName('L12', null, 'TC'), 'L12-TC');
  assert.equal(lotErp.batchName('L12', 2, 'TC'), 'L12-r2-TC');
  assert.equal(await lotErp.abbr(client), 'TC');
  assert.equal(await lotErp.warehouse(client, 'stores'), N.STORES);
  assert.equal(await lotErp.warehouse(client, 'work'), N.WORK);
  assert.equal(await lotErp.warehouse(client, 'memo'), N.MEMO);
  await assert.rejects(lotErp.warehouse(client, 'vault'), /Unknown place/);
  assert.equal(lotErp.placeOf(N.MEMO, 'TC'), 'memo');
  assert.equal(lotErp.placeOf('Finished Goods - TC', 'TC'), null);
});

// ── masters ────────────────────────────────────────────────────────────

test('ensureSetup makes the unit, the two warehouses and the two items once', async () => {
  erp._table('UOM').delete('Carat');
  assert.equal(erp.get('Warehouse', N.WORK), null);
  const start = erp.calls.length;
  const setup = await lotErp.ensureSetup(client);
  assert.deepEqual(setup, { abbr: 'TC', items: { rough: N.ROUGH, cut: N.CUT }, warehouses: { stores: N.STORES, work: N.WORK, memo: N.MEMO } });
  assert.deepEqual([posted('UOM', start), posted('Warehouse', start), posted('Item', start)], [1, 2, 2]);
  assert.equal(erp.get('UOM', 'Carat').must_be_whole_number, 0);
  // Next to Stores in the warehouse tree.
  assert.equal(erp.get('Warehouse', N.WORK).parent_warehouse, erp.get('Warehouse', N.STORES).parent_warehouse);
  assert.equal(erp.get('Warehouse', N.MEMO).company, COMPANY);
  for (const [code, name] of [[N.ROUGH, 'Rough gemstones'], [N.CUT, 'Cut gemstones']]) {
    const it = erp.get('Item', code);
    assert.deepEqual([it.item_name, it.stock_uom, it.is_stock_item, it.has_batch_no, it.create_new_batch, it.valuation_method],
      [name, 'Carat', 1, 1, 0, 'FIFO']);
    assert.ok(erp.get('Item Group', it.item_group));
  }

  // Again: remembered, ERPNext is not asked.
  const again = erp.calls.length;
  assert.deepEqual(await lotErp.ensureSetup(client), setup);
  assert.equal(erp.calls.length, again);
  // Forgotten (a failed save, a restart): it looks, finds everything, creates nothing.
  lotErp.clearCaches(COMPANY);
  assert.deepEqual(await lotErp.ensureSetup(client), setup);
  assert.ok(erp.calls.length > again);
  assert.equal(posts(again), 0);
});

test('ensureBatch gets or creates the batch of a lot, and refuses one that belongs to the other item', async () => {
  const start = erp.calls.length;
  assert.equal(await lotErp.ensureBatch(client, { code: 'K1', item: N.ROUGH, description: 'Mogok rough' }), 'K1-TC');
  assert.equal(await lotErp.ensureBatch(client, { code: 'K1', revision: 1, item: N.CUT, parent: 'K1-TC' }), 'K1-r1-TC');
  assert.equal(posted('Batch', start), 2);
  assert.deepEqual([erp.get('Batch', 'K1-TC').item, erp.get('Batch', 'K1-TC').description], [N.ROUGH, 'Mogok rough']);
  assert.deepEqual([erp.get('Batch', 'K1-r1-TC').item, erp.get('Batch', 'K1-r1-TC').parent_batch], [N.CUT, 'K1-TC']);

  // There already (an undone lot leaves its empty batch behind): used as it is.
  assert.equal(await lotErp.ensureBatch(client, { code: 'K1', item: N.ROUGH }), 'K1-TC');
  assert.equal(posted('Batch', start), 2);
  await assert.rejects(lotErp.ensureBatch(client, { code: 'K1', item: N.CUT }), /Batch K1-TC exists in ERPNext for item GEM-ROUGH-TC, not GEM-CUT-TC/);

  // Made by someone else between the look and the create: ERPNext says duplicate, that is fine.
  const notThere = (real, url, opts) => ((opts.method || 'GET') === 'GET' && decodeURIComponent(url).includes('/api/resource/Batch/')
    ? { ok: false, status: 404, text: async () => JSON.stringify({ exception: 'DoesNotExistError' }) } : real(url, opts));
  assert.equal(await withFetch(notThere, () => lotErp.ensureBatch(client, { code: 'K1', item: N.ROUGH })), 'K1-TC');
  assert.equal(erp.all('Batch').filter((b) => b.name === 'K1-TC').length, 1);
});

test('accounts: the holding and adjustment accounts by number, the cost centre, and a Stock Loss account made once', async () => {
  assert.equal(erp.get('Account', STOCK_LOSS), null);
  const start = erp.calls.length;
  acc = await lotErp.accounts(client);
  assert.deepEqual(acc, { holding: N.VALUATION, adjustment: N.ADJUSTMENT, stockLoss: STOCK_LOSS, costCenter: N.COST_CENTER });
  assert.equal(posted('Account', start), 1);
  const made = erp.get('Account', STOCK_LOSS);
  assert.equal(made.parent_account, erp.get('Account', N.ADJUSTMENT).parent_account);
  assert.equal(Number(made.is_group) || 0, 0);

  const again = erp.calls.length;
  assert.deepEqual(await lotErp.accounts(client), acc);
  assert.equal(erp.calls.length, again, 'remembered');
  lotErp.clearCaches(COMPANY);
  assert.deepEqual(await lotErp.accounts(client), acc);
  assert.equal(posts(again), 0, 'found, not made twice');

  // A company without a default cost centre cannot post stock entries: said, not guessed.
  const company = erp.get('Company', COMPANY);
  const kept = company.cost_center;
  company.cost_center = null;
  lotErp.clearCaches(COMPANY);
  await assert.rejects(lotErp.accounts(client), /no default cost centre/);
  company.cost_center = kept;
  ctx = { company: COMPANY, date: TODAY, remark: null, accounts: acc };
});

// ── the Stock Entry builders ───────────────────────────────────────────

test('builders: a transfer is the lot leaving one warehouse for another, every row with its accounts', () => {
  const doc = entries.transfer({ ...ctx, remark: 'Berpal lot op X step 1/1' }, {
    rows: [{ item: N.ROUGH, batch: 'L13-TC', warehouse: N.STORES, to: N.WORK, carats: 120.00049 }],
  });
  assert.deepEqual(doc, {
    stock_entry_type: 'Material Transfer', purpose: 'Material Transfer', company: COMPANY, posting_date: TODAY, set_posting_time: 1,
    remarks: 'Berpal lot op X step 1/1',
    items: [{
      item_code: N.ROUGH, qty: 120, uom: 'Carat', stock_uom: 'Carat', conversion_factor: 1, batch_no: 'L13-TC', use_serial_batch_fields: 1,
      expense_account: N.ADJUSTMENT, cost_center: N.COST_CENTER, s_warehouse: N.STORES, t_warehouse: N.WORK,
    }],
    docstatus: 1,
  });
  assert.throws(() => entries.transfer(ctx, { rows: [] }), /at least one lot/);
});

test('builders: a repack gives each output its value, the rate unrounded; the fee comes from the holding account', () => {
  // 120 ct of rough become 30 ct cut worth 272,400 of which 2,400 is the fee: 270,000 before it.
  const doc = entries.repack(ctx, {
    sources: [{ item: N.ROUGH, batch: 'L13-TC', warehouse: N.WORK, carats: 120 }],
    targets: [{ item: N.CUT, batch: 'L15-TC', warehouse: N.STORES, carats: 30, cost: 272400 }],
    fee: { amount: 2400 },
  });
  assert.equal(doc.stock_entry_type, 'Repack');
  assert.deepEqual(doc.items.map((i) => [i.item_code, i.batch_no, i.qty, i.s_warehouse || null, i.t_warehouse || null]),
    [[N.ROUGH, 'L13-TC', 120, N.WORK, null], [N.CUT, 'L15-TC', 30, null, N.STORES]]);
  const [src, out] = doc.items;
  assert.equal(src.set_basic_rate_manually, undefined);
  assert.deepEqual([out.set_basic_rate_manually, out.basic_rate, out.basic_amount, out.allow_zero_valuation_rate], [1, 9000, 270000, undefined]);
  assert.deepEqual(doc.additional_costs, [{ expense_account: N.VALUATION, description: 'Cutting / treatment fee', amount: 2400 }]);
  for (const i of doc.items) assert.deepEqual([i.expense_account, i.cost_center, i.use_serial_batch_fields, i.uom], [N.ADJUSTMENT, N.COST_CENTER, 1, 'Carat']);

  // 7 ct worth 100: 14.2857142857… per carat goes as it is, the amount is what counts.
  const odd = entries.repack(ctx, {
    sources: [{ item: N.ROUGH, batch: 'A-TC', warehouse: N.STORES, carats: 7 }],
    targets: [{ item: N.ROUGH, batch: 'B-TC', warehouse: N.STORES, carats: 7, cost: 100 }, { item: N.ROUGH, batch: 'C-TC', warehouse: N.STORES, carats: 1, cost: 0 }],
  });
  assert.equal(odd.additional_costs, undefined);
  assert.deepEqual([odd.items[1].basic_rate, odd.items[1].basic_amount], [100 / 7, 100]);
  // Stones that carry no cost have to say so.
  assert.deepEqual([odd.items[2].basic_rate, odd.items[2].basic_amount, odd.items[2].allow_zero_valuation_rate], [0, 0, 1]);

  assert.throws(() => entries.repack(ctx, { sources: [], targets: [{}] }), /stones going in and stones coming out/);
  assert.throws(() => entries.repack(ctx, { sources: [{}], targets: [] }), /stones going in and stones coming out/);
  assert.throws(() => entries.repack(ctx, {
    sources: [{ item: N.ROUGH, batch: 'A-TC', warehouse: N.STORES, carats: 7 }],
    targets: [{ item: N.ROUGH, batch: 'B-TC', warehouse: N.STORES, carats: 7, cost: 500 }], fee: { amount: 500 },
  }), /carry no cost of their own/);
});

test('builders: a write-off takes the stones out to the Stock Loss account', () => {
  const doc = entries.issue(ctx, { rows: [{ item: N.CUT, batch: 'L16-TC', warehouse: N.MEMO, carats: 2.5 }] });
  assert.equal(doc.stock_entry_type, 'Material Issue');
  assert.deepEqual(doc.items.map((i) => [i.batch_no, i.qty, i.s_warehouse, i.t_warehouse, i.expense_account, i.cost_center]),
    [['L16-TC', 2.5, N.MEMO, undefined, STOCK_LOSS, N.COST_CENTER]]);
  assert.throws(() => entries.issue(ctx, { rows: [] }), /at least one lot/);
});

// ── posted, and read back ──────────────────────────────────────────────

test('a repack with a fee over two outputs lands each one on its cost to the satang; voucherStock reads what happened', async () => {
  await h.seedLot(user, client, { code: 'E1', carats: 100, cost: 200000 });
  await lotErp.ensureBatch(client, { code: 'E2', item: N.CUT });
  await lotErp.ensureBatch(client, { code: 'E3', item: N.CUT });
  // 200,000 of rough + 3,333.33 of fee = 203,333.33 = 150,000.01 + 53,333.32.
  const remark = lots.remarkFor('TEST-REF-1', 1, 1);
  const se = await post(entries.repack({ ...ctx, remark }, {
    sources: [{ item: N.ROUGH, batch: 'E1-TC', warehouse: N.STORES, carats: 100 }],
    targets: [
      { item: N.CUT, batch: 'E2-TC', warehouse: N.STORES, carats: 10, cost: 150000.01 },
      { item: N.CUT, batch: 'E3-TC', warehouse: N.WORK, carats: 15.5, cost: 53333.32 },
    ],
    fee: { amount: 3333.33, description: 'Cutting E1' },
  }));
  assert.deepEqual(erp.batchValue('E2-TC', N.STORES), { qty: 10, value: 150000.01 });
  assert.deepEqual(erp.batchValue('E3-TC', N.WORK), { qty: 15.5, value: 53333.32 });
  assert.deepEqual(gl(se.name), { [N.STOCK]: 3333.33, [N.VALUATION]: -3333.33 });
  assert.equal(erp.get('Stock Entry', se.name).additional_costs[0].description, 'Cutting E1');

  const rows = (await lotErp.voucherStock(client, 'Stock Entry', se.name)).sort((a, b) => a.batch.localeCompare(b.batch));
  assert.deepEqual(rows, [
    { item: N.ROUGH, warehouse: N.STORES, batch: 'E1-TC', qty: -100, value: -200000 },
    { item: N.CUT, warehouse: N.STORES, batch: 'E2-TC', qty: 10, value: 150000.01 },
    { item: N.CUT, warehouse: N.WORK, batch: 'E3-TC', qty: 15.5, value: 53333.32 },
  ]);
  assert.deepEqual(await lotErp.voucherStock(client, 'Stock Entry', 'MAT-STE-NONE'), []);

  assert.deepEqual(await lotErp.batchStock(client, 'E1-TC'), [], 'an emptied batch is nowhere');
  assert.deepEqual(await lotErp.batchStock(client, 'E3-TC'), [{ warehouse: N.WORK, qty: 15.5, value: 53333.32 }]);
  assert.equal(await lotErp.batchQty(client, 'E3-TC', N.WORK), 15.5);
  assert.equal(await lotErp.batchQty(client, 'E3-TC', N.STORES), 0);
  assert.equal(await lotErp.batchQty(client, 'E3-TC'), 15.5, 'without a warehouse: everywhere');
});

test('a transfer and a write-off built here post as ERPNext expects', async () => {
  const moved = await post(entries.transfer({ ...ctx, remark: lots.remarkFor('TEST-REF-2', 1, 1) }, {
    rows: [{ item: N.CUT, batch: 'E3-TC', warehouse: N.WORK, to: N.MEMO, carats: 15.5 }],
  }));
  assert.deepEqual(gl(moved.name), {});
  assert.deepEqual(await lotErp.batchStock(client, 'E3-TC'), [{ warehouse: N.MEMO, qty: 15.5, value: 53333.32 }]);

  const gone = await post(entries.issue({ ...ctx, remark: lots.remarkFor('TEST-REF-3', 1, 1) }, {
    rows: [{ item: N.CUT, batch: 'E2-TC', warehouse: N.STORES, carats: 10 }],
  }));
  assert.deepEqual(gl(gone.name), { [STOCK_LOSS]: 150000.01, [N.STOCK]: -150000.01 });
  assert.deepEqual(await lotErp.batchStock(client, 'E2-TC'), []);
  ids.moved = moved.name;
});

test('findByReference finds a submitted document by its step remark, in the doctypes asked for', async () => {
  const remark = lots.remarkFor('TEST-REF-2', 1, 1);
  assert.deepEqual(await lotErp.findByReference(client, remark), { doctype: 'Stock Entry', name: ids.moved });
  assert.deepEqual(await lotErp.findByReference(client, remark, { doctypes: ['Stock Entry'] }), { doctype: 'Stock Entry', name: ids.moved });
  assert.equal(await lotErp.findByReference(client, remark, { doctypes: ['Purchase Invoice', 'Journal Entry'] }), null);
  assert.equal(await lotErp.findByReference(client, lots.remarkFor('TEST-REF-9', 1, 1)), null);

  // A cancelled document does not count: its step has to be posted again.
  await client.cancelDoc('Stock Entry', ids.moved);
  assert.equal(await lotErp.findByReference(client, remark), null);
  assert.deepEqual(await lotErp.batchStock(client, 'E3-TC'), [{ warehouse: N.WORK, qty: 15.5, value: 53333.32 }]);
});

// ── the check before a save ────────────────────────────────────────────

test('preflight: ERPNext must hold what the operation takes, where it takes it from', async () => {
  const e3 = { code: 'E3', batch: 'E3-TC', from: 'work', carats: 15.5 };
  assert.equal(await lotErp.preflight(user, client, h.resolvedOp({ kind: 'split', inputs: [e3] })), null);
  assert.equal(await lotErp.preflight(user, client, h.resolvedOp({ kind: 'split', inputs: [{ ...e3, carats: 15.5004 }] })), null, 'within the weighing tolerance');
  assert.equal(await lotErp.preflight(user, client, h.resolvedOp({ kind: 'buy', inputs: [] })), null);

  assert.equal(await lotErp.preflight(user, client, h.resolvedOp({ kind: 'split', inputs: [{ ...e3, carats: 16 }] })),
    'Lot E3: the accounts hold 15.5 ct in Out for work, but this takes 16 ct. Check the weight and where the stones are, then try again.');
  // Berpal thinks it is in Stores; ERPNext has it out for work.
  assert.equal(await lotErp.preflight(user, client, h.resolvedOp({ kind: 'sell', inputs: [{ ...e3, from: 'stores', carats: 1 }] })),
    'Lot E3: the accounts hold 0 ct in Stores, but this takes 1 ct. Check the weight and where the stones are, then try again.');
  // The same lot taken twice is counted once, together.
  assert.equal(await lotErp.preflight(user, client, h.resolvedOp({ kind: 'merge', inputs: [{ ...e3, carats: 8 }, { ...e3, carats: 7.5 }] })), null);
  assert.match(await lotErp.preflight(user, client, h.resolvedOp({ kind: 'merge', inputs: [{ ...e3, carats: 8 }, { ...e3, carats: 8 }] })), /hold 15\.5 ct .* takes 16 ct/);
  assert.equal(await lotErp.preflight(user, client, h.resolvedOp({ kind: 'split', inputs: [{ code: 'Z9', batch: null, from: 'stores', carats: 1 }] })),
    'Lot Z9 is not in the accounts yet, so nothing can be taken from it.');
  // Read-only.
  const start = erp.calls.length;
  await lotErp.preflight(user, client, h.resolvedOp({ kind: 'split', inputs: [e3] }));
  assert.equal(posted('Stock Entry', start) + posted('Batch', start), 0);
});

// ── the fee that goes into the stones ──────────────────────────────────

test('feeToStock: the net fee, plus VAT only when it cannot be claimed back; withholding changes nothing', async () => {
  const registered = await h.addUser({ vat_registered: 1 });
  const fee = (extra) => ({ transaction_type: 'cash', direction: 'expense', currency: 'THB', amount: 2400, ...extra });
  assert.equal(lotErp.feeToStock(user, null), 0);
  assert.equal(lotErp.feeToStock(user, { transaction_type: 'cash', amount: 0 }), 0);
  assert.equal(lotErp.feeToStock(user, fee()), 2400);
  assert.equal(lotErp.feeToStock(user, fee({ wht_rate: 3 })), 2400);
  // 7% on top of 2,400 = 168. Not registered: it is part of what the stones cost.
  assert.equal(lotErp.feeToStock(user, fee({ tax_rate: 7, tax_inclusive: false })), 2568);
  assert.equal(lotErp.feeToStock(registered, fee({ tax_rate: 7, tax_inclusive: false })), 2400);
  assert.equal(lotErp.feeToStock(registered, fee({ tax_rate: 7, tax_inclusive: false, vat_claimable: false })), 2568);
  // 2,568 including VAT: 2,568 × 7 / 107 = 168 of it is VAT.
  assert.equal(lotErp.feeToStock(registered, fee({ amount: 2568, tax_rate: 7, tax_inclusive: true })), 2400);
  assert.equal(lotErp.feeToStock(user, fee({ amount: 2568, tax_rate: 7, tax_inclusive: true })), 2568);
  // Lines instead of an amount; another currency at the draft's rate.
  assert.equal(lotErp.feeToStock(user, { transaction_type: 'bill_received', currency: 'THB', items: [{ description: 'Heating', qty: 2, rate: 600 }] }), 1200);
  assert.equal(lotErp.feeToStock(user, fee({ amount: 100, currency: 'USD', exchange_rate: 35.5 })), 3550);
});

// ── saveDraft's opts ───────────────────────────────────────────────────

test('saveDraft: a draft without lots posts as it always did, with or without a remark', async () => {
  await h.gemMasters(client);
  const plain = {
    transaction_type: 'bill_received', direction: 'expense', currency: 'THB', transaction_date: TODAY, category_code: '5700',
    counterparty_name: N.SUPPLIER, counterparty_contact_skipped: true, payment_terms: 'net_30', amount: 1200,
    items: [{ description: 'Loupe', qty: 2, rate: 600 }],
  };
  const a = erp.get('Purchase Invoice', (await saveDraft(user, client, plain)).erpnext_name);
  const b = erp.get('Purchase Invoice', (await saveDraft(user, client, plain, {})).erpnext_name);
  const c = erp.get('Purchase Invoice', (await saveDraft(user, client, plain, { remark: 'Berpal lot op R1 step 1/2' })).erpnext_name);
  const body = (d) => ({ update_stock: d.update_stock, grand_total: d.grand_total, items: d.items.map((i) => [i.item_code, i.qty, i.rate, i.batch_no, i.warehouse, i.expense_account]) });
  assert.deepEqual(body(b), body(a));
  assert.deepEqual(body(c), body(a));
  assert.deepEqual([a.update_stock, a.grand_total, a.items.length, a.items[0].qty, a.items[0].rate, a.items[0].batch_no], [0, 1200, 1, 2, 600, undefined]);
  assert.deepEqual([a.remarks, b.remarks, c.remarks], [undefined, undefined, 'Berpal lot op R1 step 1/2']);
  // The request itself is the same with and without empty opts.
  const sent = erp.calls.filter((x) => x.method === 'POST' && decodeURIComponent(x.url).endsWith('/api/resource/Purchase Invoice')).slice(-3).map((x) => x.body);
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual({ ...sent[2], remarks: undefined }, { ...sent[0], remarks: undefined });
});

test('saveDraft: the remark lands where each doctype keeps it and can be found again', async () => {
  const find = (ref, n) => lotErp.findByReference(client, lots.remarkFor(ref, n, 4));
  const base = { currency: 'THB', transaction_date: TODAY, counterparty_contact_skipped: true };

  const cash = await saveDraft(user, client, { ...base, transaction_type: 'cash', direction: 'expense', amount: 800, category_code: lots.FEE_CATEGORY_CODE, counterparty_name: N.CUTTER, description: 'Cutting fee' },
    { remark: lots.remarkFor('RM-1', 1, 4) });
  assert.equal(cash.doctype, 'Journal Entry');
  assert.equal(erp.get('Journal Entry', cash.erpnext_name).user_remark, `${lots.remarkFor('RM-1', 1, 4)} | Cutting fee`);
  assert.deepEqual(gl(cash.erpnext_name), { [N.VALUATION]: 800, [N.CASH]: -800 });
  assert.deepEqual(await find('RM-1', 1), { doctype: 'Journal Entry', name: cash.erpnext_name });

  const inv = await saveDraft(user, client, { ...base, transaction_type: 'invoice_issued', direction: 'income', amount: 5000, category_code: '4000', counterparty_name: N.CUSTOMER, payment_terms: 'net_30', delivery_date: TODAY, description: 'Appraisal' },
    { remark: lots.remarkFor('RM-1', 2, 4) });
  assert.equal(erp.get('Sales Invoice', inv.erpnext_name).remarks, `${lots.remarkFor('RM-1', 2, 4)} | Delivery: ${TODAY}`);
  assert.deepEqual(await find('RM-1', 2), { doctype: 'Sales Invoice', name: inv.erpnext_name });

  const pay = await saveDraft(user, client, { ...base, transaction_type: 'payment', direction: 'expense', amount: 300, counterparty_name: N.SUPPLIER, description: 'On account' },
    { remark: lots.remarkFor('RM-1', 3, 4) });
  assert.equal(pay.doctype, 'Payment Entry');
  const pe = erp.get('Payment Entry', pay.erpnext_name);
  assert.deepEqual([pe.remarks, pe.custom_remarks], [`${lots.remarkFor('RM-1', 3, 4)} | On account`, 1]);
  assert.deepEqual(await find('RM-1', 3), { doctype: 'Payment Entry', name: pay.erpnext_name });

  // Without a remark none of them mentions an operation.
  const quiet = await saveDraft(user, client, { ...base, transaction_type: 'cash', direction: 'expense', amount: 50, category_code: '5700', description: 'Tape' });
  assert.equal(erp.get('Journal Entry', quiet.erpnext_name).user_remark, 'Tape');
});

test('saveDraft: lot rows only on a bill or an invoice; the row moves the batch and the line total stays', async () => {
  const base = { currency: 'THB', transaction_date: TODAY, counterparty_contact_skipped: true, payment_terms: 'net_30' };
  const lotsOpt = [{ line: 0, item: N.ROUGH, batch: 'G1-TC', warehouse: N.STORES, carats: 3 }];
  await assert.rejects(
    saveDraft(user, client, { ...base, transaction_type: 'cash', direction: 'expense', amount: 1000, category_code: '5000', items: [{ description: 'Rough', qty: 1, rate: 1000 }] }, { lots: lotsOpt }),
    /lot lines post as a Purchase Invoice or a Sales Invoice only/
  );

  // 3 ct for 1,000: 333.33 per carat is 999.99; the missing 0.01 is a line of its own.
  await lotErp.ensureBatch(client, { code: 'G1', item: N.ROUGH });
  const bought = await saveDraft(user, client, {
    ...base, transaction_type: 'bill_received', direction: 'expense', category_code: '5000', counterparty_name: N.SUPPLIER, amount: 1000,
    items: [{ description: 'Rough G1', qty: 1, rate: 1000, lot: { code: 'G1', carats: 3 } }],
  }, { lots: lotsOpt });
  const pi = erp.get('Purchase Invoice', bought.erpnext_name);
  assert.deepEqual([pi.update_stock, pi.grand_total, pi.set_warehouse], [1, 1000, undefined]);
  assert.deepEqual(pi.items.map((i) => [i.item_code, i.qty, i.rate, i.uom || null, i.batch_no || null, i.warehouse || null, i.description]), [
    [N.ROUGH, 3, 333.33, 'Carat', 'G1-TC', N.STORES, 'Rough G1'],
    ['GEN-PURCHASE', 1, 0.01, null, null, null, 'Rounding: Rough G1'], // a plain line, as any other on a bill
  ]);
  assert.deepEqual(erp.batchValue('G1-TC', N.STORES), { qty: 3, value: 999.99 });
  assert.deepEqual(gl(pi.name), { [N.STOCK]: 999.99, [N.COGS]: 0.01, [N.CREDITORS]: -1000 });

  const sold = await saveDraft(user, client, {
    ...base, transaction_type: 'invoice_issued', direction: 'income', category_code: '4000', counterparty_name: N.CUSTOMER, amount: 2500,
    items: [{ description: 'Rough G1', qty: 1, rate: 2500, lot: { code: 'G1', carats: 3 } }],
  }, { lots: lotsOpt });
  const si = erp.get('Sales Invoice', sold.erpnext_name);
  assert.deepEqual([si.update_stock, si.grand_total], [1, 2500]);
  assert.deepEqual(si.items.map((i) => [i.item_code, i.qty, i.rate, i.batch_no || null, i.warehouse || null, i.expense_account || null]), [
    [N.ROUGH, 3, 833.33, 'G1-TC', N.STORES, N.COGS],
    ['GEN-SALE', 1, 0.01, null, null, null],
  ]);
  assert.deepEqual(gl(si.name), { [N.DEBTORS]: 2500, [N.SALES]: -2500, [N.COGS]: 999.99, [N.STOCK]: -999.99 });
  assert.deepEqual(erp.batchValue('G1-TC', N.STORES), { qty: 0, value: 0 });
});
