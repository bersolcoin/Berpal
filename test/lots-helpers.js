/**
 * Shared setup for the gem lot tests (test/lots-*.test.js). Not a test file itself.
 *
 *   const h = require('./lots-helpers');
 *   const erp = new FakeErpNext();
 *   before(async () => { erp.install(); await h.freshDb(); ({ user, client } = await h.setupGems()); });
 *
 * Lots are seeded two ways, both through the real store (src/lots/store.js), never by SQL:
 *   seedLot       the stones also exist in the fake ERPNext (a Batch + a Material Receipt)
 *   recordPosted  any ResolvedOp recorded as posted; ERPNext is whatever the test put there
 */
process.env.ERPNEXT_URL = process.env.ERPNEXT_URL || 'http://erp.test';
delete process.env.OPENAI_API_KEY;

const { newDb } = require('pg-mem');
const { COMPANY, TODAY } = require('./fake-erpnext');
const db = require('../src/db');
const erpnext = require('../src/erpnext');
const lots = require('../src/lots');
const store = require('../src/lots/store');

const ABBR = 'TC';
/** ERPNext names in the fake company (abbr TC). */
const N = {
  ROUGH: 'GEM-ROUGH-TC', CUT: 'GEM-CUT-TC',
  STORES: 'Stores - TC', WORK: 'Out for work - TC', MEMO: 'Out on memo - TC',
  STOCK: '1410 - Stock In Hand - TC', COGS: '5111 - Cost of Goods Sold - TC',
  VALUATION: '5118 - Expenses Included In Valuation - TC', ADJUSTMENT: '5119 - Stock Adjustment - TC',
  MISC: '5223 - Miscellaneous Expenses - TC', EQUITY: '3300 - Opening Balance Equity - TC',
  CASH: '1110 - Cash - TC', DEBTORS: '1310 - Debtors - TC', CREDITORS: '2110 - Creditors - TC', SALES: '4110 - Sales - TC',
  COST_CENTER: 'Main - TC', SUPPLIER: 'Mogok Rough Co', CUSTOMER: 'Siam Jewels', CUTTER: 'Somchai Cutting',
};
const WAREHOUSE = { stores: N.STORES, work: N.WORK, memo: N.MEMO };
const ITEM = { rough: N.ROUGH, cut: N.CUT };

/** A new in-memory Postgres with the whole schema. Call once per test file, in before(). */
async function freshDb() {
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
}

const CREDS = { erpnext_company: COMPANY, erpnext_api_key: 'k', erpnext_api_secret: 's' };
const clientFor = () => erpnext.forUser(CREDS);

/** The gem masters in the fake ERPNext, as lots/erp.ensureSetup will make them. Safe to repeat. */
async function gemMasters(client = clientFor()) {
  const have = async (doctype, name) => client.getResource(doctype, name).then(() => true, () => false);
  if (!(await have('Supplier', N.SUPPLIER))) await client.createSupplier({ supplier_name: N.SUPPLIER });
  if (!(await have('Supplier', N.CUTTER))) await client.createSupplier({ supplier_name: N.CUTTER });
  if (!(await have('Customer', N.CUSTOMER))) await client.createCustomer({ customer_name: N.CUSTOMER });
  for (const name of ['Out for work', 'Out on memo']) {
    if (!(await have('Warehouse', `${name} - ${ABBR}`))) await client.createResource('Warehouse', { warehouse_name: name, company: COMPANY });
  }
  for (const [code, name] of [[N.ROUGH, 'Rough gemstones'], [N.CUT, 'Cut gemstones']]) {
    if (await have('Item', code)) continue;
    await client.createResource('Item', {
      item_code: code, item_name: name, stock_uom: 'Carat', is_stock_item: 1, is_sales_item: 1, is_purchase_item: 1,
      has_batch_no: 1, create_new_batch: 0, valuation_method: 'FIFO',
    });
  }
  return client;
}

let phoneSeq = 100;
/** A user row. `niche: null` gives a general-ledger user (nothing gem may change for them). */
async function addUser({ niche = lots.NICHE, method = null, phone = `+66${++phoneSeq}`, ...extra } = {}) {
  const now = new Date().toISOString();
  const cols = {
    phone, ...CREDS, default_currency: 'THB', reporting_currency: 'THB', country: 'TH',
    niche, lot_cost_method: method, created_at: now, updated_at: now, ...extra,
  };
  const keys = Object.keys(cols);
  const { rows } = await db.query(
    `INSERT INTO users (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => cols[k])
  );
  return rows[0];
}

/** Gem masters in the fake + one gems user. erp.install() and freshDb() must have run. */
async function setupGems(opts = {}) {
  const client = await gemMasters();
  const user = await addUser(opts);
  return { user, client };
}

/** The ctx a tool's execute(args, ctx) gets from conversation.handle(). */
const ctxFor = (user, draft = {}) => ({ user, draft, conversationId: 1, saved: null, cancelled: false, confirmationRequested: false });

// ── ERPNext side (the fake) ───────────────────────────────────────────

/** A Stock Entry row the way the bot's builders must send it: both accounting fields on every row. */
const row = (r) => ({ uom: 'Carat', stock_uom: 'Carat', conversion_factor: 1, use_serial_batch_fields: 1, expense_account: N.ADJUSTMENT, cost_center: N.COST_CENTER, ...r });
/** A Repack output row whose value we set ourselves. */
const valued = (r) => row({ set_basic_rate_manually: 1, basic_rate: r.basic_amount / r.qty, ...r });

function stockEntry(client, type, items, extra = {}) {
  return client.createResource('Stock Entry', {
    stock_entry_type: type, company: COMPANY, posting_date: TODAY, set_posting_time: 1, docstatus: 1, items, ...extra,
  }).then((r) => r.data);
}

/** Signed stock ledger rows of one voucher, read over HTTP like the bot would. */
async function ledger(client, voucherNo, cancelled = 0) {
  const { data } = await client.listResource('Stock Ledger Entry', {
    filters: [['voucher_no', '=', voucherNo], ['is_cancelled', '=', cancelled]],
    fields: ['voucher_type', 'item_code', 'warehouse', 'batch_no', 'actual_qty', 'stock_value_difference', 'posting_date', 'is_cancelled'],
    limit: 100,
  });
  return data;
}

const batchQty = (client, batch, warehouse) =>
  client.callMethod('erpnext.stock.doctype.batch.batch.get_batch_qty', { batch_no: batch, warehouse }).then((r) => Number(r.message) || 0);

const batchOf = (code, revision = 0) => `${code}${revision > 0 ? `-r${revision}` : ''}-${ABBR}`;

// ── Berpal side (the store) ───────────────────────────────────────────

/** A ResolvedOp (src/lots/index.js) with every field present; pass only what the test is about. */
const resolvedOp = (o) => ({
  kind: 'split', job: null, direction: null, date: TODAY, method: 'value', inputs: [], outputs: [], fee: null,
  yield_pct: null, loss_carats: 0, holder: null, due_date: null, memo_price_per_ct: null, reason: null, note: null,
  counterparty: null, warnings: [], ...o,
});

/** ResolvedInput from a lot row. No carats = the whole lot; a part goes out at the lot's average cost. */
function input(lot, { carats, pieces, cost } = {}) {
  const whole = carats == null || Math.abs(carats - lot.carats) < 0.0005;
  const taken = whole ? lot.carats : carats;
  return {
    code: lot.code, lot_id: lot.id, carats: taken,
    pieces: pieces != null ? pieces : whole ? lot.pieces : null,
    cost: cost != null ? cost : whole ? lot.cost : Math.round((lot.cost * taken / lot.carats) * 100) / 100,
    whole, from: lot.location, item: lot.erpnext_item, batch: lot.erpnext_batch,
    before: {
      carats: lot.carats, pieces: lot.pieces, cost: lot.cost, form: lot.form, treatment: lot.treatment,
      species: lot.species, variety: lot.variety, colour: lot.colour,
      holder: lot.holder, description: lot.description, last_op_date: lot.last_op_date,
    },
  };
}

/** ResolvedOutput. `lot` given = an existing lot is re-used (new: false). */
function output({ code, carats, cost, pieces = null, damaged_pieces = 0, to = 'stores', form = 'rough', lot = null, revision, line = null, weight_estimated = false, attrs = {} }) {
  return {
    code: lot ? lot.code : code, new: !lot, lot_id: lot ? lot.id : null, carats, pieces, damaged_pieces, cost, to,
    item_kind: lots.itemKind(form), revision: revision != null ? revision : lot ? lot.revision : 0, weight_estimated, line,
    attrs: { form, ...attrs },
  };
}

/**
 * Record a ResolvedOp as posted, the way execute.run does once ERPNext has every document:
 * beginOp → recordStep per doc → postOp. New lots get the item and batch their code implies
 * unless `actuals` says otherwise.
 * @param {Array<{doctype: string, name: string}>} [docs]  ERPNext documents of the operation, in step order
 * @returns {Promise<{op: object, lots: object[]}>}  the lot_ops row (posted) and the lots after
 */
async function recordPosted(user, op, { docs = [], actuals = {}, draft = null } = {}) {
  const begun = await store.beginOp(user, { op, draft });
  for (const [i, d] of docs.entries()) await store.recordStep(begun.id, { step: i + 1, doctype: d.doctype, name: d.name });
  const outputs = { ...(actuals.outputs || {}) };
  for (const out of op.outputs || []) {
    const given = outputs[out.code] || {};
    const fresh = out.new || (out.revision || 0) > 0;
    outputs[out.code] = { ...(fresh ? { item: ITEM[out.item_kind], batch: batchOf(out.code, out.revision) } : {}), ...given };
  }
  const after = await store.postOp(begun.id, { actuals: { ...actuals, outputs } });
  return { op: await store.getOpById(begun.id), lots: after };
}

/**
 * A lot that exists on both sides: Batch + Material Receipt in the fake ERPNext (value from
 * Opening Balance Equity), and a posted 'buy' in Berpal.
 * @returns {Promise<object>} the lot row; `lot.seed` holds { op, entry } (the op row and the Stock Entry name)
 */
async function seedLot(user, client, { code, carats, cost, pieces = null, form = 'rough', location = 'stores', holder = null, date = TODAY, attrs = {} }) {
  const kind = lots.itemKind(form);
  const batch = batchOf(code);
  await client.createResource('Batch', { batch_id: batch, item: ITEM[kind] }).catch((err) => { if (err.status !== 409) throw err; });
  const entry = await stockEntry(client, 'Material Receipt', [
    row({ item_code: ITEM[kind], qty: carats, t_warehouse: WAREHOUSE[location], batch_no: batch, basic_amount: cost, expense_account: N.EQUITY }),
  ], { posting_date: date, remarks: `seed ${code}` });
  const op = resolvedOp({
    kind: 'buy', date, holder, counterparty: N.SUPPLIER, note: 'seed',
    outputs: [output({ code, carats, cost, pieces, to: location, form, attrs })],
  });
  const done = await recordPosted(user, op, { docs: [{ doctype: 'Stock Entry', name: entry.name }] });
  const lot = await store.getLot(user.id, code);
  lot.seed = { op: done.op, entry: entry.name };
  return lot;
}

/**
 * The worked example of docs/parcel-lot-stock-design.md section 6, to the satang.
 * L12 rough is bought, split by value, the better part cut (fee 2,400), the cut lot split, part
 * sent on memo and 5.5 ct of it sold.
 */
const WORKED = {
  buy: { code: 'L12', carats: 200, cost: 300000, form: 'rough' },
  split1: [{ code: 'L13', carats: 120, value: 270000, cost: 270000 }, { code: 'L14', carats: 80, value: 30000, cost: 30000 }],
  cut: { from: 'L13', code: 'L15', carats: 30, pieces: 42, fee: 2400, cost: 272400, yield_pct: 25 },
  split2: [{ code: 'L16', carats: 8, cost: 175741.94 }, { code: 'L17', carats: 22, cost: 96658.06 }],
  sale: { from: 'L16', carats: 5.5, cogs: 120822.58, left_carats: 2.5, left_cost: 54919.36 },
};

module.exports = {
  ABBR, N, WAREHOUSE, ITEM, COMPANY, TODAY, WORKED,
  freshDb, clientFor, gemMasters, addUser, setupGems, ctxFor,
  row, valued, stockEntry, ledger, batchQty, batchOf,
  resolvedOp, input, output, recordPosted, seedLot,
};
