/**
 * Parcel / lot stock in the ERPNext test double (test/fake-erpnext.js): batch-tracked carat items,
 * Batch, Stock Entry (Material Receipt / Issue / Transfer / Repack), get_batch_qty and
 * frappe.client.cancel, driven through the real client (src/erpnext.js) wherever it has a method.
 *
 * The first half replays the worked example of docs/parcel-lot-stock-design.md section 6 to the
 * satang. Steps share state and run in order. Expected figures are worked out by hand in the
 * comments (Frappe flt: exact halves round UP), never by calling the code under test.
 */
process.env.ERPNEXT_URL = 'http://erp.test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { FakeErpNext, COMPANY, TODAY } = require('./fake-erpnext');
const erpnext = require('../src/erpnext');

const erp = new FakeErpNext();
let client;

const ROUGH = 'GEM-ROUGH-TC';
const CUT = 'GEM-CUT-TC';
const STORES = 'Stores - TC';
const WORK = 'Out for work - TC';
const MEMO = 'Out on memo - TC';
const STOCK = '1410 - Stock In Hand - TC';
const COGS = '5111 - Cost of Goods Sold - TC';
const VALUATION = '5118 - Expenses Included In Valuation - TC';
const ADJUSTMENT = '5119 - Stock Adjustment - TC';
const MISC = '5223 - Miscellaneous Expenses - TC';
const EQUITY = '3300 - Opening Balance Equity - TC';
const CASH = '1110 - Cash - TC';
const DEBTORS = '1310 - Debtors - TC';
const CREDITORS = '2110 - Creditors - TC';
const SALES = '4110 - Sales - TC';
const COST_CENTER = 'Main - TC';
const SUPPLIER = 'Mogok Rough Co';
const CUSTOMER = 'Siam Jewels';

const ids = {};

/** Net Dr − Cr (company currency) per account over ALL GL rows of a voucher; zero nets dropped. */
function gl(voucherNo) {
  const out = {};
  for (const g of erp.all('GL Entry').filter((x) => x.voucher_no === voucherNo)) {
    out[g.account] = Math.round(((out[g.account] || 0) + g.debit - g.credit) * 100) / 100;
  }
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

async function balance(account) {
  return (await client.getAccountBalance(account, TODAY)).message;
}

/** Signed ledger rows of one voucher, read over HTTP like the bot would. */
async function ledger(voucherNo, cancelled = 0) {
  const { data } = await client.listResource('Stock Ledger Entry', {
    filters: [['voucher_no', '=', voucherNo], ['is_cancelled', '=', cancelled]],
    fields: ['voucher_type', 'item_code', 'warehouse', 'batch_no', 'actual_qty', 'stock_value_difference', 'posting_date', 'is_cancelled'],
    limit: 100,
  });
  return data;
}

const batchQty = (args) => client.callMethod('erpnext.stock.doctype.batch.batch.get_batch_qty', args).then((r) => r.message);
const cancel = (doctype, name) => client._fetch('POST', '/api/method/frappe.client.cancel', { doctype, name });
const newBatch = (batchId, item, extra = {}) => client.createResource('Batch', { batch_id: batchId, item, ...extra });

/** A Stock Entry row the way the bot's builders send it: both accounting fields on every row. */
const row = (r) => ({ uom: 'Carat', stock_uom: 'Carat', conversion_factor: 1, use_serial_batch_fields: 1, expense_account: ADJUSTMENT, cost_center: COST_CENTER, ...r });
/** A Repack output row whose value we set ourselves. */
const valued = (r) => row({ set_basic_rate_manually: 1, basic_rate: r.basic_amount / r.qty, ...r });

function stockEntry(type, items, extra = {}) {
  return client.createResource('Stock Entry', {
    stock_entry_type: type, company: COMPANY, posting_date: TODAY, set_posting_time: 1, docstatus: 1, items, ...extra,
  }).then((r) => r.data);
}

function purchase(items, extra = {}) {
  return client.createPurchaseInvoice({
    supplier: SUPPLIER, currency: 'THB', posting_date: TODAY, set_posting_time: 1, update_stock: 1, docstatus: 1,
    disable_rounded_total: 1, items, ...extra,
  }).then((r) => r.data);
}

function sell(items, extra = {}) {
  return client.createSalesInvoice({
    customer: CUSTOMER, currency: 'THB', posting_date: TODAY, set_posting_time: 1, update_stock: 1, docstatus: 1,
    disable_rounded_total: 1, items: items.map((i) => ({ income_account: SALES, ...i })), ...extra,
  }).then((r) => r.data);
}

/** The call must fail with this HTTP status and a message matching `re`. */
async function refused(promise, re, status = 417) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, re);
    assert.equal(err.status, status, err.message);
    return true;
  });
}

/** Counts of everything a refused document must not have written. */
const written = () => ['Stock Entry', 'Sales Invoice', 'Purchase Invoice', 'Stock Ledger Entry', 'GL Entry'].map((d) => erp.all(d).length);

before(async () => {
  erp.install();
  client = erpnext.forUser({ erpnext_company: COMPANY, erpnext_api_key: 'k', erpnext_api_secret: 's' });
  await client.createSupplier({ supplier_name: SUPPLIER });
  await client.createCustomer({ customer_name: CUSTOMER });
  await client.createResource('Warehouse', { warehouse_name: 'Out for work', company: COMPANY });
  await client.createResource('Warehouse', { warehouse_name: 'Out on memo', company: COMPANY });
  for (const [code, name] of [[ROUGH, 'Rough gemstones'], [CUT, 'Cut gemstones']]) {
    await client.createResource('Item', {
      item_code: code, item_name: name, stock_uom: 'Carat', is_stock_item: 1, is_sales_item: 1, is_purchase_item: 1,
      has_batch_no: 1, create_new_batch: 0, valuation_method: 'FIFO',
    });
  }
  // An ordinary piece item: stock UOM defaults to Nos, no batches, moving-average Bin.
  await client.createResource('Item', { item_code: 'RING-TC', item_name: 'Ring', is_stock_item: 1, is_sales_item: 1, is_purchase_item: 1 });
});

// ── set-up records ─────────────────────────────────────────────────────

test('seeded: the two stock accounts, UOMs Nos and Carat, the cost centre', async () => {
  const acc = async (name) => (await client.getResource('Account', name)).data;
  assert.equal((await acc(VALUATION)).account_type, 'Expenses Included In Valuation');
  assert.equal((await acc(ADJUSTMENT)).account_type, 'Stock Adjustment');
  assert.equal((await acc(VALUATION)).is_group, 0);
  assert.equal((await client.getResource('UOM', 'Nos')).data.must_be_whole_number, 1);
  assert.equal((await client.getResource('UOM', 'Carat')).data.must_be_whole_number, 0);
  assert.equal((await client.getResource('Cost Center', COST_CENTER)).data.company, COMPANY);
  assert.equal((await client.getResource('Company', COMPANY)).data.cost_center, COST_CENTER);
});

test('Item keeps its batch and valuation fields; an unknown stock UOM is refused', async () => {
  const item = (await client.getResource('Item', ROUGH)).data;
  assert.deepEqual(
    [item.stock_uom, item.has_batch_no, item.create_new_batch, item.valuation_method],
    ['Carat', 1, 0, 'FIFO'],
  );
  await refused(client.createResource('Item', { item_code: 'GEM-X-TC', stock_uom: 'Gram', is_stock_item: 1 }), /Could not find UOM: Gram/);
  assert.equal(erp.get('Item', 'GEM-X-TC'), null);
});

test('Batch: create, read, list, describe; duplicates and wrong items are refused', async () => {
  const made = (await newBatch('L12-TC', ROUGH, { description: 'Mogok rough, March parcel' })).data;
  assert.equal(made.name, 'L12-TC');
  assert.equal(made.batch_id, 'L12-TC');
  assert.equal(made.item, ROUGH);

  // The name is unique across the site, whichever item it is for: HTTP 409 like Frappe.
  await refused(newBatch('L12-TC', ROUGH), /DuplicateEntryError/, 409);
  await refused(newBatch('L12-TC', CUT), /DuplicateEntryError/, 409);
  await refused(newBatch('R1-TC', 'RING-TC'), /cannot have Batch/);
  await refused(newBatch('R1-TC', 'NO-SUCH-ITEM'), /Could not find Item/);
  await refused(newBatch('R1-TC', ROUGH, { parent_batch: 'NOPE' }), /Could not find Parent Batch/);
  await refused(client.createResource('Batch', { item: ROUGH }), /batch_id/);
  assert.equal(erp.get('Batch', 'R1-TC'), null);

  assert.equal((await client.getResource('Batch', 'L12-TC')).data.description, 'Mogok rough, March parcel');
  const listed = await client.listResource('Batch', { filters: [['item', '=', ROUGH]], fields: ['name', 'item', 'batch_qty'] });
  assert.deepEqual(listed.data, [{ name: 'L12-TC', item: ROUGH, batch_qty: 0 }]);
  assert.deepEqual((await client.listResource('Batch', { filters: [['item', '=', CUT]] })).data, []);

  const put = await client.updateResource('Batch', 'L12-TC', { description: 'Mogok rough, 200 ct' });
  assert.equal(put.data.description, 'Mogok rough, 200 ct');
  assert.equal((await client.getResource('Batch', 'L12-TC')).data.description, 'Mogok rough, 200 ct');
  assert.equal(erp.get('Batch', 'L12-TC').item, ROUGH, 'PUT merges, it does not replace');
  await refused(client.updateResource('Batch', 'L12-TC', { item: CUT }), /Cannot change Item of Batch/);
  await refused(client.updateResource('Batch', 'NOPE', { description: 'x' }), /DoesNotExistError/, 404);
});

// ── the worked example (design section 6) ──────────────────────────────

test('purchase: 200 ct of rough at 1,500 per carat brings 300,000 into lot L12', async () => {
  const pi = await purchase([{ item_code: ROUGH, qty: 200, rate: 1500, uom: 'Carat', warehouse: STORES, batch_no: 'L12-TC' }],
    { remarks: 'Berpal lot op OP-0001 step 1\nbought from Mogok' });
  ids.buy = pi.name;
  assert.equal(pi.items[0].amount, 300000);
  assert.deepEqual(erp.batchValue('L12-TC', STORES), { qty: 200, value: 300000 });
  assert.deepEqual(gl(pi.name), { [STOCK]: 300000, [CREDITORS]: -300000 });
  assert.deepEqual(await ledger(pi.name), [{
    voucher_type: 'Purchase Invoice', item_code: ROUGH, warehouse: STORES, batch_no: 'L12-TC',
    actual_qty: 200, stock_value_difference: 300000, posting_date: TODAY, is_cancelled: 0,
  }]);
  assert.equal(erp.get('Batch', 'L12-TC').batch_qty, 200);
  // The Bin stays per item × warehouse, summed over its batches.
  const bin = (await client.getResource('Bin', `${ROUGH}|${STORES}`)).data;
  assert.deepEqual([bin.actual_qty, bin.stock_value, bin.valuation_rate], [200, 300000, 1500]);
});

test('remarks are stored and found with a like filter', async () => {
  const hit = await client.listResource('Purchase Invoice', { filters: [['remarks', 'like', '%OP-0001%']], fields: ['name', 'remarks'] });
  assert.deepEqual(hit.data.map((d) => d.name), [ids.buy]);
  assert.match(hit.data[0].remarks, /step 1/);
  assert.deepEqual((await client.listResource('Purchase Invoice', { filters: [['remarks', 'like', '%OP-0002%']] })).data, []);
  // An anchored pattern is anchored: the reference is not at the start of the text.
  assert.deepEqual((await client.listResource('Purchase Invoice', { filters: [['remarks', 'like', 'OP-0001%']] })).data, []);
});

test('sort: a Repack splits L12 into L13 (270,000) and L14 (30,000) by the values we set', async () => {
  await newBatch('L13-TC', ROUGH, { parent_batch: 'L12-TC' });
  await newBatch('L14-TC', ROUGH, { parent_batch: 'L12-TC' });
  const se = await stockEntry('Repack', [
    row({ item_code: ROUGH, qty: 200, s_warehouse: STORES, batch_no: 'L12-TC' }),
    valued({ item_code: ROUGH, qty: 120, t_warehouse: STORES, batch_no: 'L13-TC', basic_amount: 270000 }),
    valued({ item_code: ROUGH, qty: 80, t_warehouse: STORES, batch_no: 'L14-TC', basic_amount: 30000 }),
  ], { remarks: 'Berpal lot op OP-0002 step 1' });
  ids.sort = se.name;
  assert.match(se.name, /^MAT-STE-/);
  assert.equal(se.docstatus, 1);
  assert.equal(se.purpose, 'Repack');
  assert.equal(se.stock_entry_type, 'Repack');
  assert.deepEqual([se.total_outgoing_value, se.total_incoming_value, se.value_difference], [300000, 300000, 0]);
  assert.deepEqual(se.items.map((i) => i.basic_amount), [300000, 270000, 30000]);

  assert.deepEqual(erp.batchValue('L12-TC', STORES), { qty: 0, value: 0 });
  assert.deepEqual(erp.batchValue('L13-TC', STORES), { qty: 120, value: 270000 }); // 2,250 per carat
  assert.deepEqual(erp.batchValue('L14-TC', STORES), { qty: 80, value: 30000 }); // 375 per carat
  // Out 300,000, in 300,000: nothing moves in the books and the difference account stays untouched.
  assert.deepEqual(gl(se.name), {});
  assert.equal(await balance(ADJUSTMENT), 0);
  assert.equal(await balance(STOCK), 300000);
  assert.deepEqual((await ledger(se.name)).map((e) => [e.batch_no, e.actual_qty, e.stock_value_difference]), [
    ['L12-TC', -200, -300000], ['L13-TC', 120, 270000], ['L14-TC', 80, 30000],
  ]);
  assert.deepEqual((await client.getResource('Stock Entry', se.name)).data.remarks, 'Berpal lot op OP-0002 step 1');
  const found = await client.listResource('Stock Entry', { filters: [['remarks', 'like', '%OP-0002%'], ['docstatus', '=', 1]] });
  assert.deepEqual(found.data, [{ name: se.name }]);
  // Same item, same warehouse: the Bin still shows 200 ct / 300,000 in total.
  const bin = erp.get('Bin', `${ROUGH}|${STORES}`);
  assert.deepEqual([bin.actual_qty, bin.stock_value], [200, 300000]);
});

test('send to the cutter: a Material Transfer moves L13 with its value and posts no GL', async () => {
  const se = await stockEntry('Material Transfer', [
    row({ item_code: ROUGH, qty: 120, s_warehouse: STORES, t_warehouse: WORK, batch_no: 'L13-TC' }),
  ]);
  ids.toCutter = se.name;
  assert.equal(erp.all('GL Entry').filter((g) => g.voucher_no === se.name).length, 0);
  assert.deepEqual(erp.batchValue('L13-TC', STORES), { qty: 0, value: 0 });
  assert.deepEqual(erp.batchValue('L13-TC', WORK), { qty: 120, value: 270000 });
  assert.deepEqual((await ledger(se.name)).map((e) => [e.warehouse, e.actual_qty, e.stock_value_difference]), [
    [STORES, -120, -270000], [WORK, 120, 270000],
  ]);
  assert.equal(await balance(STOCK), 300000);
  const bins = [STORES, WORK].map((w) => erp.get('Bin', `${ROUGH}|${w}`)).map((b) => [b.actual_qty, b.stock_value]);
  assert.deepEqual(bins, [[80, 30000], [120, 270000]]);
});

test('get_batch_qty: a number with a warehouse, a row per warehouse without', async () => {
  assert.equal(await batchQty({ batch_no: 'L13-TC', warehouse: WORK }), 120);
  assert.equal(await batchQty({ batch_no: 'L13-TC', warehouse: STORES }), 0);
  assert.deepEqual(await batchQty({ batch_no: 'L13-TC' }), [{ batch_no: 'L13-TC', warehouse: WORK, qty: 120 }]);
  assert.deepEqual(await batchQty({ batch_no: 'L12-TC' }), [], 'an emptied batch is in no warehouse');
  assert.deepEqual(await batchQty({ batch_no: 'L14-TC', item_code: ROUGH }), [{ batch_no: 'L14-TC', warehouse: STORES, qty: 80 }]);
  assert.equal(await batchQty({ batch_no: 'NO-SUCH-BATCH', warehouse: STORES }), 0);
  // Arguments in a POST body work too.
  const posted = await client._fetch('POST', '/api/method/erpnext.stock.doctype.batch.batch.get_batch_qty', { batch_no: 'L14-TC', warehouse: STORES });
  assert.equal(posted.message, 80);
});

test('cut: 120 ct of rough come back as 30 ct cut, and the 2,400 fee goes into the stones', async () => {
  // The cutter's bill was booked to 5118 when it arrived (here: a cash journal).
  const fee = (await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: VALUATION, debit_in_account_currency: 2400 }, { account: CASH, credit_in_account_currency: 2400 }],
  })).data;
  ids.feeJournal = fee.name;
  assert.equal(await balance(VALUATION), 2400);

  await newBatch('L15-TC', CUT, { parent_batch: 'L13-TC' });
  const se = await stockEntry('Repack', [
    row({ item_code: ROUGH, qty: 120, s_warehouse: WORK, batch_no: 'L13-TC' }),
    valued({ item_code: CUT, qty: 30, t_warehouse: STORES, batch_no: 'L15-TC', basic_amount: 270000 }),
  ], { additional_costs: [{ expense_account: VALUATION, description: 'Cutting fee', amount: 2400 }] });
  ids.cut = se.name;

  assert.deepEqual(erp.batchValue('L13-TC', WORK), { qty: 0, value: 0 });
  assert.deepEqual(erp.batchValue('L15-TC', STORES), { qty: 30, value: 272400 }); // 270,000 + 2,400 = 9,080 per carat
  assert.deepEqual([se.items[1].basic_amount, se.items[1].additional_cost, se.items[1].amount], [270000, 2400, 272400]);
  assert.deepEqual([se.total_outgoing_value, se.total_incoming_value, se.total_additional_costs, se.value_difference], [270000, 272400, 2400, 2400]);
  // Stock rises by the fee, 5118 is credited with it, the difference account is not touched.
  assert.deepEqual(gl(se.name), { [STOCK]: 2400, [VALUATION]: -2400 });
  assert.equal(await balance(VALUATION), 0);
  assert.equal(await balance(ADJUSTMENT), 0);
  assert.equal(erp.all('GL Entry').filter((g) => g.account === ADJUSTMENT).length, 0);
  assert.equal(await balance(STOCK), 302400);
});

test('grade: L15 splits into L16 (175,741.94) and L17 (96,658.06)', async () => {
  await newBatch('L16-TC', CUT, { parent_batch: 'L15-TC' });
  await newBatch('L17-TC', CUT, { parent_batch: 'L15-TC' });
  const se = await stockEntry('Repack', [
    row({ item_code: CUT, qty: 30, s_warehouse: STORES, batch_no: 'L15-TC' }),
    valued({ item_code: CUT, qty: 8, t_warehouse: STORES, batch_no: 'L16-TC', basic_amount: 175741.94 }),
    valued({ item_code: CUT, qty: 22, t_warehouse: STORES, batch_no: 'L17-TC', basic_amount: 96658.06 }),
  ]);
  ids.grade = se.name;
  assert.deepEqual(erp.batchValue('L15-TC', STORES), { qty: 0, value: 0 });
  assert.deepEqual(erp.batchValue('L16-TC', STORES), { qty: 8, value: 175741.94 });
  assert.deepEqual(erp.batchValue('L17-TC', STORES), { qty: 22, value: 96658.06 });
  assert.deepEqual(gl(se.name), {}); // 175,741.94 + 96,658.06 = 272,400.00 exactly
  assert.equal(await balance(STOCK), 302400);
});

test('memo sale: 5.5 ct of L16 leave at L16\'s own cost, not the item average', async () => {
  // 2 ct of the commercial lot go on memo too, so the warehouse holds two very different lots:
  //   L17: 2 × 96,658.06 / 22 = 8,787.0963… → 8,787.10 moves, 87,870.96 stays.
  const t17 = await stockEntry('Material Transfer', [row({ item_code: CUT, qty: 2, s_warehouse: STORES, t_warehouse: MEMO, batch_no: 'L17-TC' })]);
  ids.memo17 = t17.name;
  assert.deepEqual(erp.batchValue('L17-TC', MEMO), { qty: 2, value: 8787.1 });
  assert.deepEqual(erp.batchValue('L17-TC', STORES), { qty: 20, value: 87870.96 });
  const t16 = await stockEntry('Material Transfer', [row({ item_code: CUT, qty: 8, s_warehouse: STORES, t_warehouse: MEMO, batch_no: 'L16-TC' })]);
  ids.memo16 = t16.name;
  assert.deepEqual(erp.batchValue('L16-TC', MEMO), { qty: 8, value: 175741.94 });
  assert.deepEqual(gl(t16.name), {});

  const si = await sell([{ item_code: CUT, qty: 5.5, rate: 30000, uom: 'Carat', warehouse: MEMO, batch_no: 'L16-TC' }], { remarks: 'Berpal lot op OP-0007 step 1' });
  ids.sale = si.name;
  assert.equal(si.items[0].amount, 165000);
  // L16: 5.5 × 175,741.94 / 8 = 120,822.58375 → 120,822.58 (5.5/8 of the lot's value).
  // At the item's average in the warehouse it would have been
  //   5.5 × (175,741.94 + 8,787.10) / 10 = 101,490.97: the wrong figure.
  assert.deepEqual(gl(si.name), { [DEBTORS]: 165000, [SALES]: -165000, [COGS]: 120822.58, [STOCK]: -120822.58 });
  assert.deepEqual(erp.batchValue('L16-TC', MEMO), { qty: 2.5, value: 54919.36 }); // 175,741.94 − 120,822.58
  assert.deepEqual(erp.batchValue('L17-TC', MEMO), { qty: 2, value: 8787.1 }, 'the other lot on memo is untouched');
  assert.deepEqual(await ledger(si.name), [{
    voucher_type: 'Sales Invoice', item_code: CUT, warehouse: MEMO, batch_no: 'L16-TC',
    actual_qty: -5.5, stock_value_difference: -120822.58, posting_date: TODAY, is_cancelled: 0,
  }]);
  assert.equal(await batchQty({ batch_no: 'L16-TC', warehouse: MEMO }), 2.5);
  // Bin of the item on memo: 2.5 + 2 ct, 54,919.36 + 8,787.10.
  const bin = erp.get('Bin', `${CUT}|${MEMO}`);
  assert.deepEqual([bin.actual_qty, bin.stock_value], [4.5, 63706.46]);
  assert.equal(await balance(STOCK), 181577.42); // 302,400 − 120,822.58
});

// ── refusals ───────────────────────────────────────────────────────────

test('a batch cannot go below zero in a warehouse, whatever the item holds there', async () => {
  const snapshot = written();
  // 2.5 ct of L16 on memo; the item has 4.5 ct there.
  await refused(sell([{ item_code: CUT, qty: 3, rate: 30000, warehouse: MEMO, batch_no: 'L16-TC' }]),
    /NegativeStockError: 0\.5 units of Item GEM-CUT-TC, Batch L16-TC needed in Warehouse Out on memo - TC/);
  // L16 is not in Stores at all, although 20 ct of L17 are.
  await refused(sell([{ item_code: CUT, qty: 1, rate: 30000, warehouse: STORES, batch_no: 'L16-TC' }]),
    /NegativeStockError.*Batch L16-TC.*Stores - TC/);
  await refused(stockEntry('Material Transfer', [row({ item_code: CUT, qty: 20.001, s_warehouse: STORES, t_warehouse: MEMO, batch_no: 'L17-TC' })]),
    /NegativeStockError.*Batch L17-TC.*Stores - TC/);
  await refused(stockEntry('Material Issue', [row({ item_code: ROUGH, qty: 81, s_warehouse: STORES, batch_no: 'L14-TC' })]),
    /NegativeStockError: 1 units of Item GEM-ROUGH-TC, Batch L14-TC/);
  // Two rows of one document see each other: 50 + 31 > 80.
  await refused(stockEntry('Repack', [
    row({ item_code: ROUGH, qty: 50, s_warehouse: STORES, batch_no: 'L14-TC' }),
    row({ item_code: ROUGH, qty: 31, s_warehouse: STORES, batch_no: 'L14-TC' }),
    row({ item_code: ROUGH, qty: 81, t_warehouse: STORES, batch_no: 'L12-TC' }),
  ]), /NegativeStockError: 1 units of Item GEM-ROUGH-TC, Batch L14-TC/);
  assert.deepEqual(written(), snapshot, 'a refused document writes nothing');
  assert.deepEqual(erp.batchValue('L14-TC', STORES), { qty: 80, value: 30000 });
});

test('a batch item needs a batch of its own on every stock row', async () => {
  const snapshot = written();
  await refused(purchase([{ item_code: ROUGH, qty: 10, rate: 100, warehouse: STORES }]), /Batch No is mandatory for Item GEM-ROUGH-TC/);
  await refused(sell([{ item_code: CUT, qty: 1, rate: 100, warehouse: MEMO }]), /Batch No is mandatory for Item GEM-CUT-TC/);
  await refused(purchase([{ item_code: ROUGH, qty: 10, rate: 100, warehouse: STORES, batch_no: 'NO-SUCH-BATCH' }]), /not a valid Batch Number/);
  // L16 belongs to the cut item.
  await refused(purchase([{ item_code: ROUGH, qty: 10, rate: 100, warehouse: STORES, batch_no: 'L16-TC' }]), /L16-TC is not a valid Batch Number for Item GEM-ROUGH-TC/);
  await refused(stockEntry('Material Issue', [row({ item_code: ROUGH, qty: 1, s_warehouse: STORES })]), /Batch No is mandatory/);
  await refused(stockEntry('Material Issue', [row({ item_code: ROUGH, qty: 1, s_warehouse: STORES, batch_no: 'L17-TC' })]), /not a valid Batch Number/);
  // And an item without batches must not carry one.
  await refused(purchase([{ item_code: 'RING-TC', qty: 1, rate: 100, warehouse: STORES, batch_no: 'L14-TC' }]), /RING-TC cannot have Batch/);
  assert.deepEqual(written(), snapshot);
});

test('every Stock Entry row must name its expense account and cost centre', async () => {
  const snapshot = written();
  const base = { item_code: ROUGH, qty: 1, s_warehouse: STORES, batch_no: 'L14-TC' };
  await refused(stockEntry('Material Issue', [row({ ...base, expense_account: undefined })]), /Row 1: expense_account .* is mandatory/);
  await refused(stockEntry('Material Issue', [row({ ...base, cost_center: undefined })]), /Row 1: cost_center is mandatory/);
  // Also on a transfer, which posts nothing, and on every row, not just the first.
  await refused(stockEntry('Material Transfer', [row({ ...base, t_warehouse: WORK, cost_center: '' })]), /cost_center is mandatory/);
  await refused(stockEntry('Repack', [
    row(base),
    row({ item_code: ROUGH, qty: 1, t_warehouse: STORES, batch_no: 'L12-TC', expense_account: null }),
  ]), /Row 2: expense_account/);
  await refused(stockEntry('Material Issue', [row({ ...base, expense_account: '9999 - Nope - TC' })]), /Could not find Account/);
  await refused(stockEntry('Material Issue', [row({ ...base, cost_center: 'Nope - TC' })]), /Could not find Cost Center/);
  assert.deepEqual(written(), snapshot);
});

test('Stock Entry: unknown records and misplaced warehouses are refused', async () => {
  const snapshot = written();
  const base = { item_code: ROUGH, qty: 1, batch_no: 'L14-TC' };
  await refused(stockEntry('Material Issue', [row({ ...base, item_code: 'NO-SUCH-ITEM', s_warehouse: STORES })]), /Could not find Item/);
  await refused(stockEntry('Material Issue', [row({ ...base, s_warehouse: 'Nowhere - TC' })]), /invalid Warehouse Nowhere - TC/);
  await refused(stockEntry('Material Issue', [row({ ...base, s_warehouse: 'All Warehouses - TC' })]), /invalid Warehouse/);
  await refused(stockEntry('Material Issue', [row(base)]), /Source warehouse is mandatory/);
  await refused(stockEntry('Material Receipt', [row({ ...base, basic_rate: 1 })]), /Target warehouse is mandatory/);
  await refused(stockEntry('Material Transfer', [row({ ...base, s_warehouse: STORES })]), /Target warehouse is mandatory/);
  await refused(stockEntry('Material Transfer', [row({ ...base, s_warehouse: STORES, t_warehouse: STORES })]), /cannot be same/);
  await refused(stockEntry('Repack', [row({ ...base, s_warehouse: STORES })]), /at least one source row and one target row/);
  await refused(stockEntry('Manufacture', [row({ ...base, s_warehouse: STORES })]), /not supported/);
  await refused(stockEntry('Material Issue', [row({ ...base, s_warehouse: STORES, qty: 0 })]), /Qty/);
  await refused(stockEntry('Material Issue', [row({ ...base, s_warehouse: STORES, uom: 'Nos' })]), /UOM/);
  await refused(stockEntry('Material Issue', []), /items/);
  await refused(client.createResource('Stock Entry', { stock_entry_type: 'Material Issue', docstatus: 1, items: [row({ ...base, s_warehouse: STORES })] }), /company/);
  await refused(stockEntry('Material Receipt', [row({ ...base, t_warehouse: STORES })]), /ValuationRateMissing/);
  await refused(stockEntry('Repack', [
    row({ ...base, s_warehouse: STORES }),
    valued({ item_code: ROUGH, qty: 1, t_warehouse: STORES, batch_no: 'L12-TC', basic_amount: 375 }),
  ], { additional_costs: [{ description: 'fee', amount: 10 }] }), /Additional Costs row 1: expense_account/);
  assert.deepEqual(written(), snapshot);
});

test('a draft Stock Entry is stored but moves nothing', async () => {
  const before_ = written();
  const draft = await stockEntry('Material Issue', [row({ item_code: ROUGH, qty: 5, s_warehouse: STORES, batch_no: 'L14-TC' })], { docstatus: 0 });
  assert.equal(draft.docstatus, 0);
  assert.deepEqual(erp.batchValue('L14-TC', STORES), { qty: 80, value: 30000 });
  assert.deepEqual(written().slice(3), before_.slice(3), 'no ledger rows, no GL');
  await refused(cancel('Stock Entry', draft.name), /Draft/);
});

// ── values ERPNext works out itself ────────────────────────────────────

test('Material Receipt and Material Issue: value in, value out at the batch average, last carat takes the rest', async () => {
  await newBatch('M1-TC', ROUGH);
  const receipt = await stockEntry('Material Receipt', [
    row({ item_code: ROUGH, qty: 3, t_warehouse: STORES, batch_no: 'M1-TC', basic_amount: 100, expense_account: EQUITY }),
  ]);
  ids.m1Receipt = receipt.name;
  assert.deepEqual(erp.batchValue('M1-TC', STORES), { qty: 3, value: 100 });
  assert.deepEqual(gl(receipt.name), { [STOCK]: 100, [EQUITY]: -100 });

  const issue = (qty) => stockEntry('Material Issue', [row({ item_code: ROUGH, qty, s_warehouse: STORES, batch_no: 'M1-TC', expense_account: MISC })]);
  // 1 × 100 / 3 = 33.33; leaves 2 ct / 66.67.
  const first = await issue(1);
  ids.m1FirstIssue = first.name;
  assert.deepEqual(gl(first.name), { [MISC]: 33.33, [STOCK]: -33.33 });
  assert.deepEqual(erp.batchValue('M1-TC', STORES), { qty: 2, value: 66.67 });
  // 1 × 66.67 / 2 = 33.335 → 33.34 (half rounds up); leaves 1 ct / 33.33.
  const second = await issue(1);
  assert.deepEqual(gl(second.name), { [MISC]: 33.34, [STOCK]: -33.34 });
  // The whole remaining quantity leaves with the whole remaining value.
  const third = await issue(1);
  ids.m1LastIssue = third.name;
  assert.deepEqual(gl(third.name), { [MISC]: 33.33, [STOCK]: -33.33 });
  assert.deepEqual(erp.batchValue('M1-TC', STORES), { qty: 0, value: 0 });
  assert.equal(await balance(MISC), 100);
  assert.equal(third.items[0].basic_amount, 33.33);

  // basic_rate works as well: 4 ct × 250. (`purpose` alone names the type too.)
  await newBatch('D1-TC', ROUGH);
  const byRate = (await client.createResource('Stock Entry', {
    purpose: 'Material Receipt', company: COMPANY, posting_date: TODAY, set_posting_time: 1, docstatus: 1,
    items: [row({ item_code: ROUGH, qty: 4, t_warehouse: STORES, batch_no: 'D1-TC', basic_rate: 250, expense_account: EQUITY })],
  })).data;
  assert.equal(byRate.stock_entry_type, 'Material Receipt');
  assert.deepEqual(erp.batchValue('D1-TC', STORES), { qty: 4, value: 1000 });
  assert.deepEqual(gl(byRate.name), { [STOCK]: 1000, [EQUITY]: -1000 });
});

test('a Repack whose outputs carry no value shares the cost by quantity', async () => {
  await newBatch('Q1-TC', ROUGH);
  await stockEntry('Material Receipt', [row({ item_code: ROUGH, qty: 3, t_warehouse: STORES, batch_no: 'Q1-TC', basic_amount: 100, expense_account: EQUITY })]);
  for (const b of ['Q2-TC', 'Q3-TC', 'Q4-TC']) await newBatch(b, ROUGH, { parent_batch: 'Q1-TC' });
  const adjustmentBefore = await balance(ADJUSTMENT);
  const se = await stockEntry('Repack', [
    row({ item_code: ROUGH, qty: 3, s_warehouse: STORES, batch_no: 'Q1-TC' }),
    row({ item_code: ROUGH, qty: 1, t_warehouse: STORES, batch_no: 'Q2-TC' }),
    // A rate without basic_amount, or basic_amount without the manual flag, is ignored too.
    row({ item_code: ROUGH, qty: 1, t_warehouse: STORES, batch_no: 'Q3-TC', set_basic_rate_manually: 1, basic_rate: 90 }),
    row({ item_code: ROUGH, qty: 1, t_warehouse: STORES, batch_no: 'Q4-TC', basic_amount: 90 }),
  ]);
  ids.byWeight = se.name;
  // 100 / 3 ct = 33.33 each; the satang that cannot be shared goes to the rows' expense account.
  for (const b of ['Q2-TC', 'Q3-TC', 'Q4-TC']) assert.deepEqual(erp.batchValue(b, STORES), { qty: 1, value: 33.33 });
  assert.deepEqual(gl(se.name), { [ADJUSTMENT]: 0.01, [STOCK]: -0.01 });
  assert.equal(se.value_difference, -0.01);
  assert.equal(await balance(ADJUSTMENT), Math.round((adjustmentBefore + 0.01) * 100) / 100);
});

test('a Repack whose output values do not add up posts the difference to the row\'s expense account', async () => {
  for (const b of ['D2-TC', 'D3-TC']) await newBatch(b, ROUGH, { parent_batch: 'D1-TC' });
  const stockBefore = await balance(STOCK);
  const se = await stockEntry('Repack', [
    row({ item_code: ROUGH, qty: 4, s_warehouse: STORES, batch_no: 'D1-TC' }),
    valued({ item_code: ROUGH, qty: 2, t_warehouse: STORES, batch_no: 'D2-TC', basic_amount: 500 }),
    valued({ item_code: ROUGH, qty: 2, t_warehouse: WORK, batch_no: 'D3-TC', basic_amount: 450 }),
  ]);
  ids.shortfall = se.name;
  // 1,000 out, 950 in: stock falls by 50 and the 50 is a loss on 5119.
  assert.deepEqual(gl(se.name), { [ADJUSTMENT]: 50, [STOCK]: -50 });
  assert.deepEqual(erp.batchValue('D2-TC', STORES), { qty: 2, value: 500 });
  assert.deepEqual(erp.batchValue('D3-TC', WORK), { qty: 2, value: 450 });
  assert.equal(await balance(STOCK), Math.round((stockBefore - 50) * 100) / 100);
  assert.equal(await balance(ADJUSTMENT), 50.01);
});

test('additional costs are spread over the outputs by value and sum to the satang', async () => {
  await newBatch('A1-TC', ROUGH);
  await stockEntry('Material Receipt', [row({ item_code: ROUGH, qty: 3, t_warehouse: STORES, batch_no: 'A1-TC', basic_amount: 300, expense_account: EQUITY })]);
  for (const b of ['A2-TC', 'A3-TC', 'A4-TC']) await newBatch(b, CUT, { parent_batch: 'A1-TC' });
  await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: VALUATION, debit_in_account_currency: 100 }, { account: CASH, credit_in_account_currency: 100 }],
  });
  const se = await stockEntry('Repack', [
    row({ item_code: ROUGH, qty: 3, s_warehouse: STORES, batch_no: 'A1-TC' }),
    valued({ item_code: CUT, qty: 1, t_warehouse: STORES, batch_no: 'A2-TC', basic_amount: 100 }),
    valued({ item_code: CUT, qty: 1, t_warehouse: STORES, batch_no: 'A3-TC', basic_amount: 100 }),
    valued({ item_code: CUT, qty: 1, t_warehouse: STORES, batch_no: 'A4-TC', basic_amount: 100 }),
  ], { additional_costs: [
    { expense_account: VALUATION, description: 'Cutting fee', amount: 70 },
    { expense_account: VALUATION, description: 'Certificate', amount: 30 },
  ] });
  // 100 over three equal rows: 33.33, 33.33 and the last takes 33.34.
  assert.deepEqual(se.items.slice(1).map((i) => i.additional_cost), [33.33, 33.33, 33.34]);
  assert.deepEqual(erp.batchValue('A2-TC', STORES), { qty: 1, value: 133.33 });
  assert.deepEqual(erp.batchValue('A3-TC', STORES), { qty: 1, value: 133.33 });
  assert.deepEqual(erp.batchValue('A4-TC', STORES), { qty: 1, value: 133.34 });
  assert.deepEqual(gl(se.name), { [STOCK]: 100, [VALUATION]: -100 });
  assert.equal(await balance(VALUATION), 0);
  assert.equal(await balance(ADJUSTMENT), 50.01, 'unchanged');
});

test('fractions: fine in carats (12.37 ct at 4,042.04 = 50,000.03), refused for Nos', async () => {
  await newBatch('F1-TC', ROUGH);
  // 12.37 × 4,042.04 = 50,000.0348 → 50,000.03
  const pi = await purchase([{ item_code: ROUGH, qty: 12.37, rate: 4042.04, uom: 'Carat', warehouse: WORK, batch_no: 'F1-TC' }]);
  ids.fraction = pi.name;
  assert.equal(pi.items[0].amount, 50000.03);
  assert.equal(pi.grand_total, 50000.03);
  assert.deepEqual(erp.batchValue('F1-TC', WORK), { qty: 12.37, value: 50000.03 });
  assert.deepEqual(gl(pi.name), { [STOCK]: 50000.03, [CREDITORS]: -50000.03 });
  // Float noise does not leave crumbs: 12.37 − 0.1 − 0.2 − 12.07 is exactly nothing.
  for (const qty of [0.1, 0.2]) await stockEntry('Material Transfer', [row({ item_code: ROUGH, qty, s_warehouse: WORK, t_warehouse: STORES, batch_no: 'F1-TC' })]);
  assert.equal(await batchQty({ batch_no: 'F1-TC', warehouse: WORK }), 12.07);
  assert.equal(await batchQty({ batch_no: 'F1-TC', warehouse: STORES }), 0.3);
  for (const qty of [0.1, 0.2]) await stockEntry('Material Transfer', [row({ item_code: ROUGH, qty, s_warehouse: STORES, t_warehouse: WORK, batch_no: 'F1-TC' })]);
  assert.deepEqual(erp.batchValue('F1-TC', WORK), { qty: 12.37, value: 50000.03 });
  assert.deepEqual(erp.batchValue('F1-TC', STORES), { qty: 0, value: 0 });

  const snapshot = written();
  const ring = { item_code: 'RING-TC', rate: 100, warehouse: STORES };
  await refused(purchase([{ ...ring, qty: 1.5 }]), /Quantity \(1\.5\) cannot be a fraction.*UOM Nos/);
  const ringRow = (r) => row({ item_code: 'RING-TC', uom: 'Nos', stock_uom: 'Nos', expense_account: EQUITY, ...r });
  await refused(stockEntry('Material Receipt', [ringRow({ qty: 1.5, t_warehouse: STORES, basic_rate: 100 })]), /cannot be a fraction/);
  assert.deepEqual(written(), snapshot);

  // Whole pieces still work as before, through the moving-average Bin, with or without a Stock Entry.
  await purchase([{ ...ring, qty: 2 }]);
  const second = await stockEntry('Material Receipt', [ringRow({ qty: 2, t_warehouse: STORES, basic_rate: 200 })]);
  ids.ringReceipt = second.name;
  let bin = erp.get('Bin', `RING-TC|${STORES}`);
  assert.deepEqual([bin.actual_qty, bin.valuation_rate, bin.stock_value], [4, 150, 600]);
  const issue = await stockEntry('Material Issue', [ringRow({ qty: 1, s_warehouse: STORES, expense_account: MISC })]);
  assert.deepEqual(gl(issue.name), { [MISC]: 150, [STOCK]: -150 });
  bin = erp.get('Bin', `RING-TC|${STORES}`);
  assert.deepEqual([bin.actual_qty, bin.valuation_rate], [3, 150]);
  await refused(stockEntry('Material Issue', [ringRow({ qty: 4, s_warehouse: STORES, expense_account: MISC })]),
    /NegativeStockError: 1 units of Item RING-TC needed in Warehouse Stores - TC/);
  assert.deepEqual((await ledger(issue.name))[0].batch_no, null);
});

test('an Item with stock ledger entries keeps its batch flag and valuation method', async () => {
  await refused(client.updateResource('Item', ROUGH, { has_batch_no: 0 }), /existing transactions against item GEM-ROUGH-TC.*has_batch_no/);
  await refused(client.updateResource('Item', CUT, { valuation_method: 'Moving Average' }), /can not change the value of valuation_method/);
  assert.equal(erp.get('Item', ROUGH).has_batch_no, 1);
  // Other fields, and re-sending the same values, are fine.
  const put = await client.updateResource('Item', ROUGH, { description: 'Rough stones by the carat', has_batch_no: 1, valuation_method: 'FIFO' });
  assert.equal(put.data.description, 'Rough stones by the carat');
  // An item nothing has moved yet may still change.
  await client.createResource('Item', { item_code: 'GEM-NEW-TC', stock_uom: 'Carat', is_stock_item: 1, has_batch_no: 0 });
  assert.equal((await client.updateResource('Item', 'GEM-NEW-TC', { has_batch_no: 1, valuation_method: 'FIFO' })).data.has_batch_no, 1);
  // Submitted documents are not editable through PUT.
  await refused(client.updateResource('Stock Entry', ids.sort, { remarks: 'changed' }), /UpdateAfterSubmitError/);
});

// ── cancel ─────────────────────────────────────────────────────────────

test('cancel: a Repack is undone, batches and balances return', async () => {
  const stockBefore = await balance(STOCK);
  const res = await cancel('Stock Entry', ids.shortfall);
  assert.equal(res.message.docstatus, 2);
  assert.equal((await client.getResource('Stock Entry', ids.shortfall)).data.docstatus, 2);
  assert.deepEqual(erp.batchValue('D1-TC', STORES), { qty: 4, value: 1000 });
  assert.deepEqual(erp.batchValue('D2-TC', STORES), { qty: 0, value: 0 });
  assert.deepEqual(erp.batchValue('D3-TC', WORK), { qty: 0, value: 0 });
  assert.deepEqual(await batchQty({ batch_no: 'D3-TC' }), []);
  assert.equal(erp.get('Batch', 'D1-TC').batch_qty, 4);
  // The voucher's GL nets to zero and every row of it is flagged cancelled.
  assert.deepEqual(gl(ids.shortfall), {});
  assert.ok(erp.all('GL Entry').filter((g) => g.voucher_no === ids.shortfall).every((g) => g.is_cancelled === 1));
  assert.equal(await balance(STOCK), Math.round((stockBefore + 50) * 100) / 100);
  assert.equal(await balance(ADJUSTMENT), 0.01);
  assert.deepEqual(await ledger(ids.shortfall), []);
  assert.equal((await ledger(ids.shortfall, 1)).length, 3);

  await refused(cancel('Stock Entry', ids.shortfall), /already cancelled/);
  await refused(cancel('Stock Entry', 'MAT-STE-99999'), /DoesNotExistError/, 404);
  await refused(cancel('Batch', 'D1-TC'), /not supported/);
  await refused(client.callMethod('frappe.client.cancel', { doctype: 'Stock Entry', name: ids.sort }), /not allowed with GET/, 403);
  // The restored batch can be used again.
  const again = await stockEntry('Material Issue', [row({ item_code: ROUGH, qty: 4, s_warehouse: STORES, batch_no: 'D1-TC', expense_account: MISC })]);
  assert.deepEqual(gl(again.name), { [MISC]: 1000, [STOCK]: -1000 });
});

test('cancel is refused once something later used what the document brought in', async () => {
  const snapshot = written();
  // The sort made L13, which went to the cutter and was consumed.
  await refused(cancel('Stock Entry', ids.sort), /Cannot cancel Stock Entry .*NegativeStockError.*Batch L13-TC.*Stores - TC/);
  // The purchase of L12 was sorted away; the transfer to the cutter was cut; the cut was graded.
  await refused(cancel('Purchase Invoice', ids.buy), /Batch L12-TC/);
  await refused(cancel('Stock Entry', ids.toCutter), /Batch L13-TC.*Out for work - TC/);
  await refused(cancel('Stock Entry', ids.cut), /Batch L15-TC/);
  // F1 was bought into the work warehouse, and 0.3 ct of it went out and came back afterwards:
  // without the purchase those moves would have had nothing to take.
  await refused(cancel('Purchase Invoice', ids.fraction), /Batch F1-TC.*Out for work - TC/);
  // The receipt of M1 was issued three times.
  await refused(cancel('Stock Entry', ids.m1Receipt), /Batch M1-TC/);
  // A limit of the fake, stated loudly: ERPNext would revalue ("repost") later entries, the fake
  // cannot. The second receipt of rings (2 at 200) raised the average to 150 and one ring was
  // issued at 150 since; without that receipt it would have left at 100. Not negative, but refused.
  await refused(cancel('Stock Entry', ids.ringReceipt), /fake-erpnext: cannot cancel Stock Entry .* issued Item RING-TC from Warehouse Stores - TC afterwards and would have to be revalued/);
  // Same for a batch: undoing the FIRST issue of M1 would change what the second one was worth.
  await refused(cancel('Stock Entry', ids.m1FirstIssue), /would have to be revalued/);
  assert.deepEqual(written(), snapshot);
  assert.equal(erp.get('Stock Entry', ids.sort).docstatus, 1);
  assert.deepEqual(erp.batchValue('L14-TC', STORES), { qty: 80, value: 30000 });
  assert.deepEqual(gl(ids.cut), { [STOCK]: 2400, [VALUATION]: -2400 });

  // Newest first works: undo the last issue of M1, and it holds its last carat again.
  await cancel('Stock Entry', ids.m1LastIssue);
  assert.deepEqual(erp.batchValue('M1-TC', STORES), { qty: 1, value: 33.33 });
  assert.equal(await balance(MISC), 1216.67); // 100 + 150 (ring) + 1,000 (D1) − 33.33
});

test('cancel: an invoice with a submitted payment is refused until the payment is cancelled', async () => {
  const cashBefore = await balance(CASH);
  const pay = (await client.createPaymentEntry({
    payment_type: 'Receive', party_type: 'Customer', party: CUSTOMER, posting_date: TODAY,
    paid_from: DEBTORS, paid_to: CASH, paid_amount: 165000, received_amount: 165000,
    source_exchange_rate: 1, target_exchange_rate: 1, docstatus: 1,
    references: [{ reference_doctype: 'Sales Invoice', reference_name: ids.sale, allocated_amount: 165000 }],
  })).data;
  assert.equal(erp.get('Sales Invoice', ids.sale).outstanding_amount, 0);
  assert.equal(await balance(CASH), cashBefore + 165000);

  await refused(cancel('Sales Invoice', ids.sale), /LinkExistsError.*Payment Entry/);
  assert.equal(erp.get('Sales Invoice', ids.sale).docstatus, 1);
  assert.deepEqual(erp.batchValue('L16-TC', MEMO), { qty: 2.5, value: 54919.36 });

  await cancel('Payment Entry', pay.name);
  assert.equal(erp.get('Payment Entry', pay.name).docstatus, 2);
  assert.equal(erp.get('Sales Invoice', ids.sale).outstanding_amount, 165000);
  assert.equal(await balance(CASH), cashBefore);
  assert.equal(await balance(DEBTORS), 165000);
  assert.deepEqual(gl(pay.name), {});

  const stockBefore = await balance(STOCK);
  await cancel('Sales Invoice', ids.sale);
  assert.equal(erp.get('Sales Invoice', ids.sale).docstatus, 2);
  // The 5.5 ct are back on memo at exactly what they left at.
  assert.deepEqual(erp.batchValue('L16-TC', MEMO), { qty: 8, value: 175741.94 });
  assert.equal(await batchQty({ batch_no: 'L16-TC', warehouse: MEMO }), 8);
  assert.deepEqual(gl(ids.sale), {});
  assert.equal(await balance(COGS), 0);
  assert.equal(await balance(SALES), 0);
  assert.equal(await balance(DEBTORS), 0);
  assert.equal(await balance(STOCK), Math.round((stockBefore + 120822.58) * 100) / 100);
  const bin = erp.get('Bin', `${CUT}|${MEMO}`);
  assert.deepEqual([bin.actual_qty, bin.stock_value], [10, 184529.04]); // 175,741.94 + 8,787.10
  assert.deepEqual((await ledger(ids.sale, 1)).map((e) => e.actual_qty), [-5.5]);
});

test('cancel: purchase invoices and journal entries reverse too', async () => {
  await newBatch('P1-TC', ROUGH);
  const creditorsBefore = await balance(CREDITORS);
  const stockBefore = await balance(STOCK);
  // 7.25 ct × 1,234.56 = 8,950.56
  const pi = await purchase([{ item_code: ROUGH, qty: 7.25, rate: 1234.56, warehouse: STORES, batch_no: 'P1-TC' }]);
  assert.deepEqual(erp.batchValue('P1-TC', STORES), { qty: 7.25, value: 8950.56 });
  assert.equal(await balance(CREDITORS), Math.round((creditorsBefore - 8950.56) * 100) / 100);
  await cancel('Purchase Invoice', pi.name);
  assert.equal(erp.get('Purchase Invoice', pi.name).docstatus, 2);
  assert.deepEqual(erp.batchValue('P1-TC', STORES), { qty: 0, value: 0 });
  assert.equal(erp.get('Batch', 'P1-TC').batch_qty, 0);
  assert.equal(await balance(CREDITORS), creditorsBefore);
  assert.equal(await balance(STOCK), stockBefore);
  assert.deepEqual(gl(pi.name), {});
  await refused(cancel('Purchase Invoice', pi.name), /already cancelled/);

  const je = (await client.createJournalEntry({
    posting_date: TODAY, docstatus: 1,
    accounts: [{ account: MISC, debit_in_account_currency: 77 }, { account: CASH, credit_in_account_currency: 77 }],
  })).data;
  const cash = await balance(CASH);
  await cancel('Journal Entry', je.name);
  assert.equal(await balance(CASH), cash + 77);
  assert.deepEqual(gl(je.name), {});
  assert.equal(erp.get('Journal Entry', je.name).docstatus, 2);
});

test('the books still balance, and stock in hand equals what the batches and bins hold', async () => {
  const live = erp.all('GL Entry').filter((g) => !g.is_cancelled);
  const net = Math.round(live.reduce((n, g) => n + g.debit - g.credit, 0) * 100) / 100;
  assert.equal(net, 0);
  const bins = Math.round(erp.all('Bin').reduce((n, b) => n + b.stock_value, 0) * 100) / 100;
  assert.equal(await balance(STOCK), bins);
  // Every live voucher balances on its own.
  const perVoucher = new Map();
  for (const g of live) perVoucher.set(g.voucher_no, Math.round(((perVoucher.get(g.voucher_no) || 0) + g.debit - g.credit) * 100) / 100);
  assert.deepEqual([...perVoucher].filter(([, n]) => n !== 0), []);
});
