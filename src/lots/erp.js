/**
 * Gem lots in ERPNext: names, the masters a gem company needs, and reading stock back.
 *
 *   items       GEM-ROUGH-<abbr> / GEM-CUT-<abbr>   stock UOM Carat, batch-tracked, FIFO
 *   batch       <LOTCODE>-<abbr>, or <LOTCODE>-r<revision>-<abbr> once the lot was recut / re-weighed
 *   warehouses  Stores / Out for work / Out on memo  - <abbr>
 *
 * ERPNext is the authority on carats and value; Berpal's lot rows are the authority on pieces,
 * attributes and who holds what. Nothing in here writes the lot tables.
 */
const lots = require('./index');
const { companyAbbr, ensureItemGroup, ITEM_GROUP } = require('../erp-sync/items');
const { round2, txRate, companyCurrency } = require('../erp-sync/common');
const { computeTotals, vatTreatment } = require('../erp-sync/taxes');

const UOM = 'Carat';
const ITEM_BASE = { rough: 'GEM-ROUGH', cut: 'GEM-CUT' };
/** Doctypes an operation's documents may be, in the order findByReference searches them. */
const REFERENCE_DOCTYPES = ['Stock Entry', 'Purchase Invoice', 'Sales Invoice', 'Journal Entry', 'Payment Entry'];
/** The field each doctype keeps a free-text remark in (a Journal Entry has no `remarks`). */
const REMARK_FIELD = { 'Journal Entry': 'user_remark' };

const abbr = (erp) => companyAbbr(erp);

/** @param {'rough'|'cut'} kind  @returns {string} ERPNext item code */
function itemCode(kind, companyAbbreviation) {
  if (!ITEM_BASE[kind]) throw new Error(`Unknown gem item kind: ${kind}`);
  return `${ITEM_BASE[kind]}-${companyAbbreviation}`;
}

/** @param {'stores'|'work'|'memo'} place  @returns {Promise<string>} ERPNext warehouse name */
async function warehouse(erp, place) {
  if (!lots.PLACES[place]) throw new Error(`Unknown place: ${place}`);
  return `${lots.PLACES[place]} - ${await abbr(erp)}`;
}

/** Warehouse name → place key, or null when it is not one of the three. */
function placeOf(warehouseName, companyAbbreviation) {
  const hit = Object.entries(lots.PLACES).find(([, name]) => warehouseName === `${name} - ${companyAbbreviation}`);
  return hit ? hit[0] : null;
}

/** The batch a lot's stones sit in. Revision 0 is the lot as first received. */
function batchName(code, revision, companyAbbreviation) {
  const rev = Number(revision) || 0;
  return `${code}${rev > 0 ? `-r${rev}` : ''}-${companyAbbreviation}`;
}

/** Carats ERPNext holds of a batch in one warehouse (0 when none). */
async function batchQty(erp, batch, warehouseName) {
  const r = await erp.callMethod('erpnext.stock.doctype.batch.batch.get_batch_qty', { batch_no: batch, warehouse: warehouseName });
  const m = r && r.message;
  if (Array.isArray(m)) return lots.round3(m.reduce((s, x) => s + Number(x.qty || 0), 0));
  return lots.round3(Number(m) || 0);
}

/**
 * Where a batch sits and what it is worth, from the Stock Ledger (cancelled entries left out).
 * One row per warehouse that still holds some of it or carries a value.
 * @returns {Promise<Array<{warehouse: string, qty: number, value: number}>>}
 */
async function batchStock(erp, batch) {
  const r = await erp.listResource('Stock Ledger Entry', {
    filters: [['batch_no', '=', batch], ['is_cancelled', '=', 0]],
    fields: ['warehouse', 'actual_qty', 'stock_value_difference'],
    limit: 10000,
  });
  const by = new Map();
  for (const e of r.data || []) {
    const w = by.get(e.warehouse) || { warehouse: e.warehouse, qty: 0, value: 0 };
    w.qty += Number(e.actual_qty || 0);
    w.value += Number(e.stock_value_difference || 0);
    by.set(e.warehouse, w);
  }
  return [...by.values()]
    .map((w) => ({ warehouse: w.warehouse, qty: lots.round3(w.qty), value: Math.round(w.value * 100) / 100 }))
    .filter((w) => w.qty !== 0 || w.value !== 0);
}

/**
 * A submitted document carrying this remark (lots.remarkFor), or null. This is how an operation
 * finds a step it posted but could not record (a crash or a timeout between the two).
 * @returns {Promise<{doctype: string, name: string}|null>}
 */
async function findByReference(erp, remark, { doctypes = REFERENCE_DOCTYPES } = {}) {
  for (const doctype of doctypes) {
    const r = await erp.listResource(doctype, {
      filters: [[REMARK_FIELD[doctype] || 'remarks', 'like', `%${remark}%`], ['docstatus', '=', 1]],
      fields: ['name'],
      limit: 1,
    });
    if (r.data && r.data.length) return { doctype, name: r.data[0].name };
  }
  return null;
}

// ── Masters ──────────────────────────────────────────────────────────

const STOCK_LOSS_ACCOUNT = 'Stock Loss';
const ITEM_NAMES = { rough: 'Rough gemstones', cut: 'Cut gemstones' };
const _setupCache = new Map();
const _accountsCache = new Map();

/** Forget what was memoised for a company (after a failed save; tests with a fresh ERPNext). */
function clearCaches(company) {
  _setupCache.delete(company);
  _accountsCache.delete(company);
}

/** GET by name; null when ERPNext has no such document. */
async function findDoc(erp, doctype, name) {
  try {
    return (await erp.getResource(doctype, name)).data;
  } catch (err) {
    if (err.status !== 404) throw err;
    return null;
  }
}

/** Create, treating "it is there already" (someone else made it a moment ago) as done. */
async function createUnlessThere(erp, doctype, data) {
  try {
    await erp.createResource(doctype, data);
    return true;
  } catch (err) {
    if (err.status !== 409) throw err;
    return false;
  }
}

/**
 * Make sure the two items, the three warehouses and the UOM exist for this company (get-or-create;
 * safe to call before every operation; cached per company).
 * @returns {Promise<{abbr: string, items: {rough: string, cut: string}, warehouses: {stores: string, work: string, memo: string}}>}
 */
async function ensureSetup(erp) {
  if (_setupCache.has(erp.company)) return _setupCache.get(erp.company);
  const a = await abbr(erp);

  if (!(await findDoc(erp, 'UOM', UOM))) {
    await createUnlessThere(erp, 'UOM', { uom_name: UOM, must_be_whole_number: 0 });
    console.log(`• [lots] created UOM ${UOM}`);
  }

  // New warehouses go next to Stores in the company's warehouse tree.
  const warehouses = {};
  let parent;
  for (const place of Object.keys(lots.PLACES)) {
    const name = `${lots.PLACES[place]} - ${a}`;
    warehouses[place] = name;
    const found = await findDoc(erp, 'Warehouse', name);
    if (place === 'stores') parent = found && found.parent_warehouse;
    if (found) continue;
    await createUnlessThere(erp, 'Warehouse', {
      warehouse_name: lots.PLACES[place], company: erp.company, is_group: 0,
      ...(parent ? { parent_warehouse: parent } : {}),
    });
    console.log(`• [lots] created Warehouse ${name}`);
  }

  const items = {};
  for (const kind of Object.keys(ITEM_BASE)) {
    const code = itemCode(kind, a);
    items[kind] = code;
    if (await findDoc(erp, 'Item', code)) continue;
    await ensureItemGroup(erp);
    await createUnlessThere(erp, 'Item', {
      item_code: code, item_name: ITEM_NAMES[kind], item_group: ITEM_GROUP, stock_uom: UOM,
      is_stock_item: 1, is_sales_item: 1, is_purchase_item: 1,
      // Every lot is its own batch with its own cost; Berpal names the batches (ensureBatch).
      has_batch_no: 1, create_new_batch: 0, valuation_method: 'FIFO',
    });
    console.log(`• [lots] created Item ${code}`);
  }

  const setup = { abbr: a, items, warehouses };
  _setupCache.set(erp.company, setup);
  return setup;
}

/**
 * Get or create the Batch of a lot. Get-or-create matters: a lot deleted by an undo leaves its
 * (empty) batch behind in ERPNext, and the code is then free to be used again.
 * @param {{code: string, revision?: number, item: string, description?: string, parent?: string}} args
 * @returns {Promise<string>} the batch name (batchName(code, revision, abbr))
 */
async function ensureBatch(erp, { code, revision = 0, item, description = null, parent = null }) {
  const name = batchName(code, revision, await abbr(erp));
  const found = await findDoc(erp, 'Batch', name);
  if (found) {
    if (found.item !== item) throw new Error(`Batch ${name} exists in ERPNext for item ${found.item}, not ${item}`);
    return name;
  }
  await createUnlessThere(erp, 'Batch', {
    batch_id: name, item,
    ...(description ? { description } : {}),
    ...(parent ? { parent_batch: parent } : {}),
  });
  return name;
}

/** The company's ledger account whose name starts with this account number. */
async function accountByNumber(erp, number) {
  const r = await erp.listResource('Account', {
    filters: [['company', '=', erp.company], ['name', 'like', `${number} - %`], ['is_group', '=', 0]],
    fields: ['name', 'parent_account'],
    limit: 1,
  });
  const hit = r.data && r.data[0];
  if (!hit) throw new Error(`[erpnext] no account ${number} in the chart of company ${erp.company}; gem lots need it`);
  return hit;
}

/** Where a write-off goes: the "Stock Loss" ledger, made next to Stock Adjustment the first time. */
async function stockLossAccount(erp, adjustment) {
  const existing = await erp.listResource('Account', {
    filters: [['company', '=', erp.company], ['account_name', '=', STOCK_LOSS_ACCOUNT]],
    fields: ['name', 'is_group'],
    limit: 5,
  });
  const leaf = (existing.data || []).find((x) => !Number(x.is_group));
  if (leaf) return leaf.name;
  if ((existing.data || []).length) {
    throw new Error(`[erpnext] "${existing.data[0].name}" is a group account; ${STOCK_LOSS_ACCOUNT} must be a ledger (leaf) account. Fix the chart of accounts.`);
  }
  if (!adjustment.parent_account) {
    throw new Error(`[erpnext] ${adjustment.name} has no parent group to put ${STOCK_LOSS_ACCOUNT} under`);
  }
  const made = await erp.createAccount({ account_name: STOCK_LOSS_ACCOUNT, parent_account: adjustment.parent_account });
  console.log(`• [lots] created Account ${made.data && made.data.name}`);
  return made.data.name;
}

/**
 * The accounts and cost centre lot documents post to.
 * @returns {Promise<{holding: string, adjustment: string, stockLoss: string, costCenter: string}>}
 *   holding = "Expenses Included In Valuation" (lots.HOLDING_ACCOUNT_NUMBER), adjustment = "Stock
 *   Adjustment" (lots.ADJUSTMENT_ACCOUNT_NUMBER), stockLoss = where a write-off goes.
 */
async function accounts(erp) {
  if (_accountsCache.has(erp.company)) return _accountsCache.get(erp.company);
  const holding = await accountByNumber(erp, lots.HOLDING_ACCOUNT_NUMBER);
  const adjustment = await accountByNumber(erp, lots.ADJUSTMENT_ACCOUNT_NUMBER);
  const company = (await erp.getResource('Company', erp.company)).data;
  if (!company.cost_center) throw new Error(`[erpnext] company ${erp.company} has no default cost centre`);
  const out = {
    holding: holding.name,
    adjustment: adjustment.name,
    stockLoss: await stockLossAccount(erp, adjustment),
    costCenter: company.cost_center,
  };
  _accountsCache.set(erp.company, out);
  return out;
}

// ── Reading back ─────────────────────────────────────────────────────

/**
 * What a submitted document really did to stock, from the Stock Ledger.
 * @returns {Promise<Array<{item: string, warehouse: string, batch: string, qty: number, value: number}>>}
 *   one row per ledger entry; qty and value negative for stock that left
 */
async function voucherStock(erp, doctype, name) {
  const r = await erp.listResource('Stock Ledger Entry', {
    filters: [['voucher_type', '=', doctype], ['voucher_no', '=', name], ['is_cancelled', '=', 0]],
    fields: ['item_code', 'warehouse', 'batch_no', 'actual_qty', 'stock_value_difference'],
    limit: 10000,
  });
  return (r.data || []).map((e) => ({
    item: e.item_code,
    warehouse: e.warehouse,
    batch: e.batch_no,
    qty: lots.round3(Number(e.actual_qty || 0)),
    value: round2(Number(e.stock_value_difference || 0)),
  }));
}

/**
 * How much of the draft's fee goes into the cost of the stones, in company currency: the net
 * amount, plus VAT when it cannot be claimed back; withholding tax changes nothing. Pure.
 * @returns {number}
 */
function feeToStock(user, draft) {
  if (!draft || !(Number(draft.amount) > 0 || (Array.isArray(draft.items) && draft.items.length))) return 0;
  const t = computeTotals(draft);
  const amount = vatTreatment(user, draft) === 'non_claimable' ? t.gross : t.net;
  const rate = !draft.currency || draft.currency === companyCurrency(user) ? 1 : txRate(user, draft);
  return round2(amount * rate);
}

const ct = (n) => `${lots.round3(n)} ct`;

/**
 * Read-only check before the card and before the save: does ERPNext hold every input where Berpal
 * thinks it is (batch quantity in the `from` warehouse >= carats taken), and does the gem setup
 * exist or can it be made?
 * @returns {Promise<string|null>} what is wrong, in words for the trader; null when fine
 */
async function preflight(user, erp, op) {
  // One check per batch and place: the same lot may be taken twice in one operation.
  const taken = new Map();
  for (const input of (op && op.inputs) || []) {
    const key = `${input.batch}|${input.from}`;
    const t = taken.get(key) || { code: input.code, batch: input.batch, from: input.from, carats: 0 };
    t.carats = lots.round3(t.carats + Number(input.carats || 0));
    taken.set(key, t);
  }
  for (const t of taken.values()) {
    const place = lots.PLACES[t.from] || t.from;
    if (!t.batch) return `Lot ${t.code} is not in the accounts yet, so nothing can be taken from it.`;
    const held = await batchQty(erp, t.batch, await warehouse(erp, t.from));
    if (held + 0.0005 < t.carats) {
      return `Lot ${t.code}: the accounts hold ${ct(held)} in ${place}, but this takes ${ct(t.carats)}. `
        + 'Check the weight and where the stones are, then try again.';
    }
  }
  return null;
}

module.exports = {
  UOM, REFERENCE_DOCTYPES,
  abbr, itemCode, warehouse, placeOf, batchName, batchQty, batchStock, findByReference,
  ensureSetup, ensureBatch, accounts, voucherStock, feeToStock, preflight, clearCaches,
};
