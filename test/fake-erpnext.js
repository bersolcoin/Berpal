/**
 * In-memory stand-in for the ERPNext REST API, installed as global.fetch.
 *
 * Not a full ERPNext — but it enforces the validations the bot has actually tripped over
 * in real ERPNext, so payload mistakes fail here the same way:
 *   - party account currency must equal document currency
 *   - Journal Entries must balance in company currency; foreign accounts need multi_currency
 *   - Receivable/Payable lines need a party
 *   - Sales/Purchase Invoices ignore posting_date unless set_posting_time=1
 *   - Payment Entry: reference_no/date mandatory with a Bank account; difference must be 0;
 *     allocation can't exceed outstanding
 *   - invoice tax rows: account_head must be a leaf of this company of a tax-capable type; 'Actual'
 *     can't be inclusive; Deduct (WHT) lowers grand_total → outstanding
 *   - update_stock: stock rows need a warehouse; selling below zero is a NegativeStockError
 *     unless Stock Settings.allow_negative_stock
 *   - batch-tracked items (gem lots, docs/parcel-lot-stock-design.md section 15): a stock row needs
 *     a batch_no of that item; with a valuation method other than Moving Average, quantity and
 *     value are kept per batch per warehouse; no batch may go below zero in a warehouse
 *   - Stock Entry (Material Receipt / Issue / Transfer, Repack with additional costs): every row
 *     must name its expense_account and cost_center; value differences post to that account
 *   - frappe.client.cancel reverses a submitted document, and is refused when something later
 *     consumed the stock it brought in or a submitted Payment Entry still points at the invoice
 * Submitted documents post GL Entries, so balance / ledger queries read real results.
 */
const COMPANY = 'Test Co';
const ABBR = 'TC';
const BASE = 'THB';
const TODAY = new Date().toISOString().slice(0, 10);
const STOCK_ACCOUNT = `1410 - Stock In Hand - ${ABBR}`;
const ROUND_OFF_ACCOUNT = `5225 - Round Off - ${ABBR}`;
const COST_CENTER = `Main - ${ABBR}`;
const STOCK_ENTRY_TYPES = ['Material Receipt', 'Material Issue', 'Material Transfer', 'Repack'];
const CANCELLABLE = ['Stock Entry', 'Sales Invoice', 'Purchase Invoice', 'Journal Entry', 'Payment Entry'];
// Item fields ERPNext freezes once the item has stock ledger entries (item.py cant_change).
const ITEM_FROZEN_FIELDS = ['has_batch_no', 'valuation_method', 'is_stock_item', 'has_serial_no'];
// account_type values ERPNext lets a Sales/Purchase Taxes and Charges row point at. The server's
// validate_account_head only checks company + non-group; the type rule is the account_head link
// filter and Item Tax Template validation. The fake enforces it server-side on purpose so a tax
// row aimed at e.g. a Receivable or Cash account fails in tests instead of corrupting the books.
const TAX_HEAD_TYPES = ['Tax', 'Chargeable', 'Income Account', 'Expense Account', 'Expenses Included In Valuation'];

// Frappe's flt(n, 2) with the default "Banker's Rounding (legacy)" method: pre-round to 8 dp to
// shed float noise, then an exact half rounds UP (toward +∞). Number.EPSILON is useless here —
// 1234.5 × 0.03 = 37.034999… must still come out 37.04, as ERPNext posts it.
function r2(n) {
  return Math.round(Number((Number(n) * 100).toFixed(8))) / 100;
}

// Quantities (carats are fractional): only shed float noise. ERPNext itself rounds a quantity to
// the site's float precision (3 dp by default); the fake does not model that.
function rq(n) {
  return Number(Number(n).toFixed(6)) + 0; // + 0: never -0
}

class ErpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function seedAccounts() {
  const A = (num, name, extra) => ({
    name: `${num} - ${name} - ${ABBR}`, account_name: name, company: COMPANY,
    is_group: 0, account_currency: BASE, disabled: 0, account_type: '', ...extra,
  });
  return [
    A('1000', 'Current Assets', { is_group: 1, root_type: 'Asset' }),
    A('1100', 'Cash In Hand', { is_group: 1, root_type: 'Asset', account_type: 'Cash', parent_account: `1000 - Current Assets - ${ABBR}` }),
    A('1110', 'Cash', { root_type: 'Asset', account_type: 'Cash', parent_account: `1100 - Cash In Hand - ${ABBR}` }),
    A('1200', 'Bank Accounts', { is_group: 1, root_type: 'Asset', account_type: 'Bank', parent_account: `1000 - Current Assets - ${ABBR}` }),
    A('1300', 'Accounts Receivable', { is_group: 1, root_type: 'Asset', account_type: 'Receivable' }),
    A('1310', 'Debtors', { root_type: 'Asset', account_type: 'Receivable', parent_account: `1300 - Accounts Receivable - ${ABBR}` }),
    A('2000', 'Current Liabilities', { is_group: 1, root_type: 'Liability' }),
    A('2100', 'Accounts Payable', { is_group: 1, root_type: 'Liability', account_type: 'Payable', parent_account: `2000 - Current Liabilities - ${ABBR}` }),
    A('2110', 'Creditors', { root_type: 'Liability', account_type: 'Payable', parent_account: `2100 - Accounts Payable - ${ABBR}` }),
    A('3300', 'Opening Balance Equity', { root_type: 'Equity' }),
    A('4110', 'Sales', { root_type: 'Income' }),
    A('4120', 'Service', { root_type: 'Income' }),
    A('5110', 'Stock Expenses', { is_group: 1, root_type: 'Expense' }),
    A('5111', 'Cost of Goods Sold', { root_type: 'Expense', parent_account: `5110 - Stock Expenses - ${ABBR}` }),
    // Standard-chart stock accounts the lot flows post to: 5118 holds a cutter's fee until the
    // transform moves it into stock, 5119 takes value differences on a Repack.
    A('5118', 'Expenses Included In Valuation', { root_type: 'Expense', account_type: 'Expenses Included In Valuation', parent_account: `5110 - Stock Expenses - ${ABBR}` }),
    A('5119', 'Stock Adjustment', { root_type: 'Expense', account_type: 'Stock Adjustment', parent_account: `5110 - Stock Expenses - ${ABBR}` }),
    A('5204', 'Entertainment Expenses', { root_type: 'Expense' }),
    A('5206', 'Legal Expenses', { root_type: 'Expense' }),
    A('5209', 'Office Rent', { root_type: 'Expense' }),
    A('5216', 'Travel Expenses', { root_type: 'Expense' }),
    A('5223', 'Miscellaneous Expenses', { root_type: 'Expense' }),
    A('5225', 'Round Off', { root_type: 'Expense', account_type: 'Round Off' }),
    A('2300', 'Duties and Taxes', { is_group: 1, root_type: 'Liability', account_type: 'Tax', parent_account: `2000 - Current Liabilities - ${ABBR}` }),
    A('1500', 'Tax Assets', { is_group: 1, root_type: 'Asset', parent_account: `1000 - Current Assets - ${ABBR}` }),
    A('1400', 'Stock Assets', { is_group: 1, root_type: 'Asset', account_type: 'Stock', parent_account: `1000 - Current Assets - ${ABBR}` }),
    A('1410', 'Stock In Hand', { root_type: 'Asset', account_type: 'Stock', parent_account: `1400 - Stock Assets - ${ABBR}` }),
  ];
}

function matchFilter(doc, [field, op, val]) {
  const v = doc[field];
  switch (op) {
    case '=': return v == val; // eslint-disable-line eqeqeq
    case '!=': return v != val; // eslint-disable-line eqeqeq
    case '>': return v > val;
    case '<': return v < val;
    case '>=': return v >= val;
    case '<=': return v <= val;
    case 'in': return val.includes(v);
    case 'between': return v >= val[0] && v <= val[1];
    case 'like': {
      const re = new RegExp(`^${String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'is'); // s: % spans newlines, as SQL LIKE does
      return re.test(String(v ?? ''));
    }
    default: throw new ErpError(417, `fake-erpnext: unsupported filter op ${op}`);
  }
}

/**
 * One moving-average Bin step. An entry carrying `_in_value` is a valued receipt and re-averages
 * the rate; any other entry only moves quantity. Used by the planner below and by the replay that
 * rebuilds a Bin when a document is cancelled, so both give the figures the invoice path gives.
 */
function movingAverage(bin, sle) {
  const qty = rq(bin.qty + sle.actual_qty);
  if (sle._in_value === undefined) return { qty, rate: bin.rate };
  return { qty, rate: qty > 0 ? r2((bin.qty * bin.rate + sle._in_value) / qty) : bin.rate };
}

/**
 * The stock moves of one document, worked out before anything is written: each row sees the rows
 * before it, and a row that would take a batch (or a non-batch item) below zero in a warehouse
 * throws while the books are still untouched. commit() writes the Stock Ledger Entries.
 *
 * Batch-wise valued items: a batch's quantity and value in a warehouse are the sums of its ledger
 * rows; an issue leaves at that batch's own average, and takes the whole remaining value when the
 * whole remaining quantity leaves. Everything else is valued through the moving-average Bin.
 * Simplification: valuation always reads the current state, also for a back-dated document (the
 * negative-stock check does respect the posting date); ERPNext would repost later entries.
 */
class StockPlan {
  constructor(erp, voucherType, postingDate, postingTime) {
    this.erp = erp;
    this.voucherType = voucherType;
    this.postingDate = postingDate;
    this.postingTime = postingTime;
    this.allowNegative = !!erp.get('Stock Settings', 'Stock Settings')?.allow_negative_stock;
    this.pending = new Map(); // quantity this document has already moved, per batch|warehouse or item|warehouse
    this.batches = new Map();
    this.bins = new Map();
    this.sles = [];
  }

  _batch(batchNo, warehouse) {
    const key = `${batchNo}|${warehouse}`;
    if (!this.batches.has(key)) this.batches.set(key, this.erp.batchValue(batchNo, warehouse));
    return this.batches.get(key);
  }

  _bin(itemCode, warehouse) {
    const key = `${itemCode}|${warehouse}`;
    if (!this.bins.has(key)) {
      const b = this.erp.get('Bin', key);
      this.bins.set(key, { qty: b ? b.actual_qty : 0, rate: b ? b.valuation_rate : 0 });
    }
    return this.bins.get(key);
  }

  /** Issue `qty` and return the value that leaves (positive, 2 dp). */
  out({ item, warehouse, batchNo = null, qty }) {
    const key = batchNo ? `b|${batchNo}|${warehouse}` : `i|${item.name}|${warehouse}`;
    const moved = this.pending.get(key) || 0;
    const avail = rq(this.erp._minBalance({ itemCode: item.name, warehouse, batchNo, date: this.postingDate, time: this.postingTime }) + moved);
    if (!this.allowNegative && avail - qty < -0.0000005) {
      throw new ErpError(417, this.erp._negativeStockMessage(rq(qty - avail), item.name, batchNo, warehouse, this.postingDate));
    }
    this.pending.set(key, rq(moved - qty));
    let value;
    if (batchNo && this.erp._batchwise(item)) {
      const st = this._batch(batchNo, warehouse);
      const rate = st.qty > 0 ? st.value / st.qty : (item.valuation_rate || 0);
      value = rq(st.qty - qty) === 0 ? st.value : r2(qty * rate);
      st.qty = rq(st.qty - qty);
      st.value = r2(st.value - value);
    } else {
      const bin = this._bin(item.name, warehouse);
      if (!bin.rate && !item.valuation_rate) {
        throw new ErpError(417, `ValuationRateMissing: Valuation Rate for the Item ${item.name}, is required to do accounting entries for ${this.voucherType}.`);
      }
      value = r2(qty * bin.rate);
      Object.assign(bin, movingAverage(bin, { actual_qty: -qty }));
    }
    this.sles.push({ item_code: item.name, warehouse, batch_no: batchNo, actual_qty: -qty, stock_value_difference: -value });
    return value;
  }

  /** Receive `qty` worth `value` (company currency, 2 dp). */
  in({ item, warehouse, batchNo = null, qty, value }) {
    const key = batchNo ? `b|${batchNo}|${warehouse}` : `i|${item.name}|${warehouse}`;
    this.pending.set(key, rq((this.pending.get(key) || 0) + qty));
    const sle = { item_code: item.name, warehouse, batch_no: batchNo, actual_qty: qty, stock_value_difference: value };
    if (batchNo && this.erp._batchwise(item)) {
      const st = this._batch(batchNo, warehouse);
      st.qty = rq(st.qty + qty);
      st.value = r2(st.value + value);
    } else {
      sle._in_value = value;
      const bin = this._bin(item.name, warehouse);
      Object.assign(bin, movingAverage(bin, sle));
    }
    this.sles.push(sle);
  }

  commit(voucherNo) {
    for (const s of this.sles) {
      this.erp._put('Stock Ledger Entry', {
        name: this.erp._seq('SLE'), ...s, posting_date: this.postingDate, posting_time: this.postingTime,
        creation: new Date().toISOString(), voucher_type: this.voucherType, voucher_no: voucherNo, is_cancelled: 0,
      });
    }
    this.erp._refreshStock(this.sles);
  }
}

class FakeErpNext {
  constructor() {
    this.docs = new Map();
    this.counters = {};
    this.calls = [];
    // Extension points for feature tests: extra /api/method handlers and extra doctypes.
    //   erp.methods['frappe.utils.print_format.download_pdf'] = (url, body) => ({...})
    //   erp.createHandlers['Sales Taxes and Charges Template'] = (d) => doc
    this.methods = {};
    this.createHandlers = {};
    for (const a of seedAccounts()) this._put('Account', a);
    this._put('Company', { name: COMPANY, abbr: ABBR, default_currency: BASE, default_inventory_account: STOCK_ACCOUNT, cost_center: COST_CENTER });
    this._put('Cost Center', { name: COST_CENTER, cost_center_name: 'Main', company: COMPANY, is_group: 0 });
    this._put('UOM', { name: 'Nos', uom_name: 'Nos', must_be_whole_number: 1, enabled: 1 });
    this._put('UOM', { name: 'Carat', uom_name: 'Carat', must_be_whole_number: 0, enabled: 1 });
    this._put('Warehouse', { name: `All Warehouses - ${ABBR}`, company: COMPANY, is_group: 1 });
    this._put('Warehouse', { name: `Stores - ${ABBR}`, company: COMPANY, is_group: 0, parent_warehouse: `All Warehouses - ${ABBR}` });
    this._put('Warehouse', { name: `Finished Goods - ${ABBR}`, company: COMPANY, is_group: 0, parent_warehouse: `All Warehouses - ${ABBR}` });
    // Fresh sites point default_warehouse at the first company's Stores; leave it unset so the
    // bot's own "Stores - <abbr>" fallback is what's exercised.
    this._put('Stock Settings', { name: 'Stock Settings', allow_negative_stock: 0, default_warehouse: null });
    this._put('Item Group', { name: 'All Item Groups', item_group_name: 'All Item Groups', is_group: 1 });
  }

  _table(doctype) {
    if (!this.docs.has(doctype)) this.docs.set(doctype, new Map());
    return this.docs.get(doctype);
  }
  _put(doctype, doc) {
    this._table(doctype).set(doc.name, doc);
    return doc;
  }
  get(doctype, name) {
    return this._table(doctype).get(name) || null;
  }
  all(doctype) {
    return [...this._table(doctype).values()];
  }
  _seq(prefix) {
    this.counters[prefix] = (this.counters[prefix] || 0) + 1;
    return `${prefix}-2026-${String(this.counters[prefix]).padStart(5, '0')}`;
  }
  account(name) {
    const a = this.get('Account', name);
    if (!a) throw new ErpError(417, `LinkValidationError: Could not find Account: ${name}`);
    if (a.is_group) throw new ErpError(417, `Account ${name} is a group account; cannot post to it`);
    return a;
  }

  /** Lowest running stock balance of item/warehouse from `date` onward (incl. the balance on `date`). */
  _minQtyFrom(itemCode, warehouse, date, time) {
    // Sequenced like ERPNext: posting date, posting time, then creation.
    const key = (e) => `${e.posting_date} ${e.posting_time} ${e.creation}`;
    const sles = this.all('Stock Ledger Entry')
      .filter((e) => e.item_code === itemCode && e.warehouse === warehouse && !e.is_cancelled)
      .sort((a, b) => key(a).localeCompare(key(b)));
    const at = `${date} ${time}`;
    const before = (e) => `${e.posting_date} ${e.posting_time}` <= at;
    let bal = 0;
    for (const e of sles) if (before(e)) bal += e.actual_qty;
    let min = bal;
    for (const e of sles) {
      if (before(e)) continue;
      bal += e.actual_qty;
      min = Math.min(min, bal);
    }
    return r2(min);
  }

  /**
   * Lowest running balance of a batch (or, without batchNo, of an item) in a warehouse from
   * `date time` onward, never above the balance at that moment. Without a date: the lowest point
   * of the whole ledger (0 when it never dips). `excludeVoucher` leaves one document's rows out,
   * which is how cancel asks "would the stock still be there without this document?".
   */
  _minBalance({ itemCode, warehouse, batchNo = null, date = null, time = '', excludeVoucher = null }) {
    const key = (e) => `${e.posting_date} ${e.posting_time} ${e.creation}`;
    const sles = this.all('Stock Ledger Entry')
      .filter((e) => e.item_code === itemCode && e.warehouse === warehouse && !e.is_cancelled
        && (!batchNo || e.batch_no === batchNo)
        && !(excludeVoucher && e.voucher_type === excludeVoucher.doctype && e.voucher_no === excludeVoucher.name))
      .sort((a, b) => key(a).localeCompare(key(b)));
    const at = `${date} ${time}`;
    const before = (e) => date !== null && `${e.posting_date} ${e.posting_time}` <= at;
    let bal = 0;
    for (const e of sles) if (before(e)) bal += e.actual_qty;
    let min = bal;
    for (const e of sles) {
      if (before(e)) continue;
      bal += e.actual_qty;
      min = Math.min(min, bal);
    }
    return rq(min);
  }

  _negativeStockMessage(deficit, itemCode, batchNo, warehouse, date) {
    const what = batchNo ? `Item ${itemCode}, Batch ${batchNo}` : `Item ${itemCode}`;
    return `NegativeStockError: ${deficit} units of ${what} needed in Warehouse ${warehouse} on ${date} to complete this transaction.`;
  }

  /** Batch-wise valuation: a batch-tracked item whose valuation method is not Moving Average. */
  _batchwise(item) {
    return !!item.has_batch_no && item.valuation_method !== 'Moving Average';
  }

  /** Test helper (not an HTTP method): what a batch holds in one warehouse, { qty, value }. */
  batchValue(batchNo, warehouse) {
    let qty = 0, value = 0;
    for (const e of this.all('Stock Ledger Entry')) {
      if (e.is_cancelled || e.batch_no !== batchNo || e.warehouse !== warehouse) continue;
      qty += e.actual_qty;
      value += e.stock_value_difference;
    }
    return { qty: rq(qty), value: r2(value) + 0 }; // + 0: an emptied batch is 0, never -0
  }

  /** Recompute a Bin from its live ledger rows: batch-wise items sum their batches, others replay the moving average. */
  _rebuildBin(itemCode, warehouse) {
    const key = `${itemCode}|${warehouse}`;
    const sles = this.all('Stock Ledger Entry').filter((e) => e.item_code === itemCode && e.warehouse === warehouse && !e.is_cancelled);
    let bin = this.get('Bin', key);
    if (!bin) {
      if (!sles.length) return;
      bin = this._put('Bin', { name: key, item_code: itemCode, warehouse, actual_qty: 0, valuation_rate: 0, stock_value: 0 });
    }
    const item = this.get('Item', itemCode);
    if (item && this._batchwise(item)) {
      bin.actual_qty = rq(sles.reduce((n, e) => n + e.actual_qty, 0));
      bin.stock_value = r2(sles.reduce((n, e) => n + e.stock_value_difference, 0)) + 0;
      bin.valuation_rate = bin.actual_qty > 0 ? r2(bin.stock_value / bin.actual_qty) : 0;
    } else {
      let st = { qty: 0, rate: 0 };
      for (const e of sles) st = movingAverage(st, e);
      bin.actual_qty = st.qty;
      bin.valuation_rate = st.rate;
      bin.stock_value = r2(st.qty * st.rate);
    }
  }

  /** After ledger rows were written or cancelled: refresh the Bins and Batch.batch_qty they touch. */
  _refreshStock(sles) {
    for (const key of new Set(sles.map((e) => `${e.item_code}|${e.warehouse}`))) {
      const cut = key.indexOf('|');
      this._rebuildBin(key.slice(0, cut), key.slice(cut + 1));
    }
    for (const batchNo of new Set(sles.map((e) => e.batch_no).filter(Boolean))) {
      const batch = this.get('Batch', batchNo);
      if (!batch) continue;
      batch.batch_qty = rq(this.all('Stock Ledger Entry')
        .filter((e) => e.batch_no === batchNo && !e.is_cancelled).reduce((n, e) => n + e.actual_qty, 0));
    }
  }

  /** The whole-number rule belongs to the item's stock UOM (Nos: yes, Carat: no). Items default to Nos. */
  _checkWholeQty(item, qty, n) {
    const uom = item.stock_uom || 'Nos';
    if (this.get('UOM', uom)?.must_be_whole_number && !Number.isInteger(Number(qty))) {
      throw new ErpError(417, `Row ${n}: Quantity (${qty}) cannot be a fraction. To allow this, disable 'Must be Whole Number' in UOM ${uom}.`);
    }
  }

  /** The fake keeps no UOM conversion tables: a row may only be stated in the item's stock UOM. */
  _checkRowUom(item, row, n) {
    const stockUom = item.stock_uom || 'Nos';
    for (const f of ['uom', 'stock_uom']) {
      if (row[f] && row[f] !== stockUom) throw new ErpError(417, `Row ${n}: UOM Conversion factor is required for UOM ${row[f]} in Item ${item.name} (stock UOM ${stockUom})`);
    }
    if (row.conversion_factor != null && Number(row.conversion_factor) !== 1) {
      throw new ErpError(417, `fake-erpnext: Row ${n}: conversion_factor other than 1 is not supported`);
    }
  }

  /**
   * stock_ledger_entry.py validate_item: a batch-tracked item needs a batch of its own on every
   * stock row (our items have create_new_batch 0, so ERPNext never makes one up), and an item
   * without batches must not carry one.
   */
  _checkBatch(item, batchNo, n) {
    if (!item.has_batch_no) {
      if (batchNo) throw new ErpError(417, `Row ${n}: The Item ${item.name} cannot have Batch`);
      return;
    }
    if (!batchNo) throw new ErpError(417, `Row ${n}: Batch No is mandatory for Item ${item.name}`);
    const batch = this.get('Batch', batchNo);
    if (!batch || batch.item !== item.name) throw new ErpError(417, `Row ${n}: ${batchNo} is not a valid Batch Number for Item ${item.name}`);
    if (batch.disabled) throw new ErpError(417, `Row ${n}: Batch ${batchNo} is disabled`);
  }

  _checkWarehouse(warehouse, n) {
    const w = this.get('Warehouse', warehouse);
    if (!w || w.company !== COMPANY || w.is_group) throw new ErpError(417, `Row ${n}: invalid Warehouse ${warehouse}`);
  }

  /** Dr/Cr in account currency + company currency. */
  _gl(voucherType, voucherNo, date, rows) {
    for (const row of rows) {
      this._put('GL Entry', {
        name: this._seq('GLE'),
        company: COMPANY, posting_date: date, voucher_type: voucherType, voucher_no: voucherNo,
        is_cancelled: 0, account: row.account, account_currency: this.account(row.account).account_currency,
        debit_in_account_currency: row.dr || 0, credit_in_account_currency: row.cr || 0,
        debit: row.baseDr || 0, credit: row.baseCr || 0,
        party_type: row.party_type || null, party: row.party || null, against: row.against || null,
      });
    }
  }

  // ── doctype handlers ────────────────────────────────────────────────
  createAccount(d) {
    if (!d.parent_account || !this.get('Account', d.parent_account)) {
      throw new ErpError(417, `Parent account ${d.parent_account} not found`);
    }
    const parent = this.get('Account', d.parent_account);
    return this._put('Account', {
      name: `${d.account_name} - ${ABBR}`, account_name: d.account_name, company: COMPANY,
      is_group: d.is_group || 0, account_currency: d.account_currency || BASE, disabled: 0,
      account_type: d.account_type || '', root_type: parent.root_type, parent_account: d.parent_account,
    });
  }

  createParty(doctype, d) {
    const nameField = doctype === 'Customer' ? 'customer_name' : 'supplier_name';
    let name = d[nameField];
    if (this.get(doctype, name)) name = `${name}-1`;
    return this._put(doctype, { ...d, name });
  }

  /**
   * Sales / Purchase Invoice, with the parts of calculate_taxes_and_totals the bot relies on:
   *   - taxes: 'On Net Total' (rate) and 'Actual' rows; included_in_print_rate backs inclusive VAT
   *     out of the item rates; purchase rows can Deduct (WHT), which lowers grand_total
   *   - rounded_total (whole units) unless disable_rounded_total, diff to Round Off
   *   - update_stock: stock Items move their Bin (moving-average valuation); sales post COGS at
   *     valuation and are refused below zero (NegativeStockError) unless allow_negative_stock
   */
  createInvoice(doctype, d) {
    const isSales = doctype === 'Sales Invoice';
    const partyField = isSales ? 'customer' : 'supplier';
    const partyType = isSales ? 'Customer' : 'Supplier';
    if (!this.get(partyType, d[partyField])) throw new ErpError(417, `Could not find ${partyType}: ${d[partyField]}`);
    const accField = isSales ? 'debit_to' : 'credit_to';
    const partyAccount = d[accField] || (isSales ? `1310 - Debtors - ${ABBR}` : `2110 - Creditors - ${ABBR}`);
    const acc = this.account(partyAccount);
    if (acc.account_currency !== d.currency) {
      throw new ErpError(417, 'Party Account currency and document currency should be same');
    }
    if (d.currency !== BASE && !(d.conversion_rate > 0)) throw new ErpError(417, 'Exchange Rate is mandatory');
    const rate = d.currency === BASE ? 1 : d.conversion_rate;
    const postingDate = d.set_posting_time ? d.posting_date : TODAY;
    // posting_time defaults to now, as in ERPNext.
    const postingTime = d.posting_time || new Date().toTimeString().slice(0, 8);
    const submit = (d.docstatus || 0) === 1;

    // ── item rows ── (rate is rounded to 2 dp before multiplying, as ERPNext does)
    let total = 0;
    const lines = [];
    (d.items || []).forEach((it, idx) => {
      const item = this.get('Item', it.item_code);
      if (!item) throw new ErpError(417, `Could not find Item: ${it.item_code}`);
      if (isSales && !item.is_sales_item) throw new ErpError(417, `Item ${it.item_code} is not a sales Item`);
      if (!isSales && !item.is_purchase_item) throw new ErpError(417, `Item ${it.item_code} is not a purchase Item`);
      // UOM Nos has must_be_whole_number=1; Carat does not.
      this._checkWholeQty(item, it.qty, idx + 1);
      this._checkRowUom(item, it, idx + 1);
      const amount = r2(it.qty * r2(it.rate));
      total += amount;
      const stock = !!(item.is_stock_item && d.update_stock);
      const warehouse = it.warehouse || d.set_warehouse || null;
      if (stock) {
        if (!warehouse) throw new ErpError(417, `Row ${idx + 1}: Warehouse is mandatory for stock Item ${it.item_code}`);
        const w = this.get('Warehouse', warehouse);
        if (!w || w.company !== COMPANY || w.is_group) throw new ErpError(417, `Row ${idx + 1}: invalid Warehouse ${warehouse}`);
      }
      lines.push({ it, item, amount, stock, warehouse, n: idx + 1 });
    });
    total = r2(total);

    // ── taxes ──
    const taxes = (d.taxes || []).map((t, idx) => {
      const head = this.account(t.account_head); // must exist + not be a group (validate_account_head)
      if (head.company !== COMPANY) throw new ErpError(417, `Row ${idx + 1}: Account ${t.account_head} does not belong to Company ${COMPANY}`);
      if (!TAX_HEAD_TYPES.includes(head.account_type)) {
        throw new ErpError(417, `Row ${idx + 1}: Account ${t.account_head} must be of type Tax, Chargeable, Income Account or Expense Account`);
      }
      if (!['On Net Total', 'Actual'].includes(t.charge_type)) throw new ErpError(417, `fake-erpnext: charge_type ${t.charge_type} not supported`);
      if (t.charge_type === 'Actual' && t.included_in_print_rate) {
        throw new ErpError(417, `Charge of type 'Actual' in row ${idx + 1} cannot be included in Item Rate or Paid Amount`);
      }
      const deduct = !isSales && t.add_deduct_tax === 'Deduct';
      if (deduct && t.included_in_print_rate) throw new ErpError(417, `Row ${idx + 1}: a deducted tax cannot be included in Item Rate`);
      return { ...t, deduct };
    });
    // Inclusive taxes, as current ERPNext (v14 >= Aug 2024, v15) computes them: each row's
    // net_amount = flt(amount / (1 + sum of inclusive rates)); the tax = flt(rate x net_total); any
    // cent between net + tax and the item total is grand_total_diff, posted to Round Off.
    const inclRate = taxes.filter((t) => t.included_in_print_rate && t.charge_type === 'On Net Total')
      .reduce((s, t) => s + Number(t.rate), 0);
    for (const l of lines) l.net = inclRate ? r2(l.amount / (1 + inclRate / 100)) : l.amount;
    const netTotal = r2(lines.reduce((s, l) => s + l.net, 0));
    for (const t of taxes) t.tax_amount = t.charge_type === 'Actual' ? r2(t.tax_amount) : r2(netTotal * t.rate / 100);
    const taxTotal = r2(taxes.reduce((s, t) => s + (t.deduct ? -t.tax_amount : t.tax_amount), 0));
    const allInclusive = taxes.length > 0 && taxes.every((t) => t.included_in_print_rate);
    const grandTotalDiff = allInclusive ? r2(total - netTotal - taxTotal) : 0;
    const grand = r2(netTotal + taxTotal + grandTotalDiff);
    const rounded = d.disable_rounded_total ? grand : Math.round(grand);
    const roundingAdj = r2(rounded - grand);
    const outstanding = d.disable_rounded_total ? grand : rounded;

    // ── stock moves (validated before anything is written) ──
    const allowNegative = !!this.get('Stock Settings', 'Stock Settings')?.allow_negative_stock;
    const moves = [];
    // Batch-tracked rows go through the planner: a purchase brings the row's net amount (company
    // currency) into its batch, a sale leaves at that batch's own average in that warehouse.
    const plan = new StockPlan(this, doctype, postingDate, postingTime);
    if (submit) {
      const pending = new Map();
      for (const l of lines.filter((x) => x.stock)) {
        this._checkBatch(l.item, l.it.batch_no, l.n);
        if (l.item.has_batch_no) {
          if (!(l.it.qty > 0)) throw new ErpError(417, `fake-erpnext: Row ${l.n}: returns of batch items are not supported`);
          const move = { item: l.item, warehouse: l.warehouse, batchNo: l.it.batch_no, qty: Number(l.it.qty) };
          if (isSales) l.batchCost = plan.out(move);
          else plan.in({ ...move, value: r2(l.net * rate) });
          continue;
        }
        const key = `${l.it.item_code}|${l.warehouse}`;
        const bin = this.get('Bin', key) || { actual_qty: 0, valuation_rate: 0 };
        const already = pending.get(key) || 0;
        if (isSales) {
          // Back-dated issues must not make ANY point of the ledger from the posting date on negative.
          const minAvail = this._minQtyFrom(l.it.item_code, l.warehouse, postingDate, postingTime) - already;
          if (!allowNegative && minAvail - l.it.qty < -0.0001) {
            throw new ErpError(417, `NegativeStockError: ${r2(l.it.qty - minAvail)} units of Item ${l.it.item_code} needed in Warehouse ${l.warehouse} on ${postingDate} to complete this transaction.`);
          }
          // stock_ledger.py: even with negative stock allowed, an item that was never valued
          // can't be issued -- there's no rate to book COGS at.
          if (!bin.valuation_rate && !l.item.valuation_rate) {
            throw new ErpError(417, `ValuationRateMissing: Valuation Rate for the Item ${l.it.item_code}, is required to do accounting entries for ${doctype}.`);
          }
        }
        pending.set(key, already + l.it.qty);
        moves.push(l);
      }
    }

    const name = this._seq(isSales ? 'ACC-SINV' : 'ACC-PINV');
    const doc = this._put(doctype, {
      ...d, name, company: COMPANY, posting_date: postingDate, [accField]: partyAccount,
      conversion_rate: rate, total, net_total: netTotal, total_taxes_and_charges: taxTotal,
      items: lines.map((l) => ({ ...l.it, amount: l.amount, net_amount: l.net })),
      taxes: taxes.map(({ deduct, ...t }) => t),
      grand_total: grand, grand_total_diff: grandTotalDiff, rounded_total: rounded, rounding_adjustment: roundingAdj,
      outstanding_amount: outstanding,
      party_account_currency: acc.account_currency, docstatus: d.docstatus || 0,
      [isSales ? 'customer_name' : 'supplier_name']: this.get(partyType, d[partyField])[isSales ? 'customer_name' : 'supplier_name'],
    });
    if (!submit) return doc;

    // ── GL: every non-party row in base currency, party row = their sum so it always balances ──
    const party = d[partyField];
    const gl = [];
    const base = (n) => r2(n * rate);
    for (const l of lines) {
      let lineAcc;
      if (isSales) lineAcc = l.it.income_account;
      else lineAcc = l.stock ? STOCK_ACCOUNT : l.it.expense_account; // perpetual inventory: stock rows hit the warehouse account
      if (!lineAcc) throw new ErpError(417, `${isSales ? 'Income' : 'Expense'} account missing on item row`);
      this.account(lineAcc);
      gl.push(isSales
        ? { account: lineAcc, cr: base(l.net), baseCr: base(l.net), against: party }
        : { account: lineAcc, dr: base(l.net), baseDr: base(l.net), against: party });
    }
    for (const t of taxes) {
      const amt = base(t.tax_amount);
      const credit = isSales ? !t.deduct : t.deduct;
      gl.push(credit ? { account: t.account_head, cr: amt, baseCr: amt } : { account: t.account_head, dr: amt, baseDr: amt });
    }
    const roundOff = r2(roundingAdj + grandTotalDiff);
    if (roundOff) {
      const amt = base(Math.abs(roundOff));
      const credit = isSales ? roundOff > 0 : roundOff < 0;
      gl.push(credit ? { account: ROUND_OFF_ACCOUNT, cr: amt, baseCr: amt } : { account: ROUND_OFF_ACCOUNT, dr: amt, baseDr: amt });
    }
    const net = r2(gl.reduce((s, g) => s + (g.baseCr || 0) - (g.baseDr || 0), 0));
    const partyRow = { account: partyAccount, party_type: partyType, party };
    // Sales: credits exceed debits → the party is debited; purchase: the reverse.
    gl.unshift(isSales ? { ...partyRow, dr: r2(outstanding), baseDr: net } : { ...partyRow, cr: r2(outstanding), baseCr: -net });

    // Stock: purchase receives at the base net rate; sale issues at valuation and books COGS.
    for (const l of moves) {
      const key = `${l.it.item_code}|${l.warehouse}`;
      const bin = this.get('Bin', key) || this._put('Bin', {
        name: key, item_code: l.it.item_code, warehouse: l.warehouse, actual_qty: 0, valuation_rate: 0, stock_value: 0,
      });
      let valued;
      if (isSales) {
        const cost = r2(l.it.qty * bin.valuation_rate);
        const cogs = l.it.expense_account || `5111 - Cost of Goods Sold - ${ABBR}`;
        this.account(cogs);
        gl.push({ account: cogs, dr: cost, baseDr: cost }, { account: STOCK_ACCOUNT, cr: cost, baseCr: cost });
        bin.actual_qty = rq(bin.actual_qty - l.it.qty);
        valued = { stock_value_difference: -cost };
      } else {
        const inValue = base(l.net);
        const qty = rq(bin.actual_qty + l.it.qty);
        bin.valuation_rate = qty > 0 ? r2((bin.actual_qty * bin.valuation_rate + inValue) / qty) : bin.valuation_rate;
        bin.actual_qty = qty;
        // _in_value marks a valued receipt for the moving-average replay (_rebuildBin).
        valued = { stock_value_difference: inValue, _in_value: inValue };
      }
      bin.stock_value = r2(bin.actual_qty * bin.valuation_rate);
      this._put('Stock Ledger Entry', {
        name: this._seq('SLE'), item_code: l.it.item_code, warehouse: l.warehouse, posting_date: postingDate,
        posting_time: postingTime, creation: new Date().toISOString(), actual_qty: isSales ? -l.it.qty : l.it.qty, voucher_type: doctype, voucher_no: name, is_cancelled: 0,
        batch_no: null, ...valued,
      });
    }
    for (const l of lines.filter((x) => x.batchCost !== undefined)) {
      const cogs = l.it.expense_account || `5111 - Cost of Goods Sold - ${ABBR}`;
      this.account(cogs);
      gl.push({ account: cogs, dr: l.batchCost, baseDr: l.batchCost }, { account: STOCK_ACCOUNT, cr: l.batchCost, baseCr: l.batchCost });
    }
    plan.commit(name);
    this._gl(doctype, name, postingDate, gl);
    return doc;
  }

  createJournalEntry(d) {
    let dr = 0, cr = 0, multi = false;
    const gl = [];
    for (const row of d.accounts || []) {
      const acc = this.account(row.account);
      if (row.account_currency && row.account_currency !== acc.account_currency) {
        throw new ErpError(417, `Row account currency ${row.account_currency} != ${acc.account_currency}`);
      }
      if (acc.account_currency !== BASE) multi = true;
      if (['Receivable', 'Payable'].includes(acc.account_type) && !(row.party_type && row.party)) {
        throw new ErpError(417, `Party Type and Party is required for Receivable / Payable account ${row.account}`);
      }
      if (row.party && !this.get(row.party_type, row.party)) throw new ErpError(417, `Could not find ${row.party_type}: ${row.party}`);
      const rate = row.exchange_rate || 1;
      if (acc.account_currency === BASE && rate !== 1) throw new ErpError(417, 'Exchange rate must be 1 for company-currency account');
      const dIn = row.debit_in_account_currency || 0;
      const cIn = row.credit_in_account_currency || 0;
      const bd = r2(dIn * rate);
      const bc = r2(cIn * rate);
      dr += bd;
      cr += bc;
      gl.push({ account: row.account, dr: dIn, cr: cIn, baseDr: bd, baseCr: bc, party_type: row.party_type, party: row.party });
    }
    if (multi && !d.multi_currency) {
      throw new ErpError(417, 'Please check Multi Currency option to allow accounts with other currency');
    }
    if (Math.abs(r2(dr) - r2(cr)) > 0.001) {
      throw new ErpError(417, `Total Debit must be equal to Total Credit. The difference is ${r2(dr - cr)}`);
    }
    const name = this._seq('ACC-JV');
    const doc = this._put('Journal Entry', { ...d, name, company: COMPANY, docstatus: d.docstatus || 0,
      accounts: d.accounts.map((a) => ({ ...a, account_currency: this.account(a.account).account_currency })) });
    if (doc.docstatus === 1) this._gl('Journal Entry', name, d.posting_date, gl);
    return doc;
  }

  createPaymentEntry(d) {
    const from = this.account(d.paid_from);
    const to = this.account(d.paid_to);
    if (d.paid_from_account_currency && d.paid_from_account_currency !== from.account_currency) {
      throw new ErpError(417, 'paid_from currency mismatch');
    }
    if (d.paid_to_account_currency && d.paid_to_account_currency !== to.account_currency) {
      throw new ErpError(417, 'paid_to currency mismatch');
    }
    const receive = d.payment_type === 'Receive';
    const partyAcc = receive ? from : to;
    const wantType = receive ? 'Receivable' : 'Payable';
    if (partyAcc.account_type !== wantType) {
      throw new ErpError(417, `Party account ${partyAcc.name} must be ${wantType} for ${d.payment_type}`);
    }
    if (!this.get(d.party_type, d.party)) throw new ErpError(417, `Could not find ${d.party_type}: ${d.party}`);
    if ((from.account_type === 'Bank' || to.account_type === 'Bank') && !(d.reference_no && d.reference_date)) {
      throw new ErpError(417, 'Reference No and Reference Date is mandatory for Bank transaction');
    }
    for (const [cur, rate] of [[from.account_currency, d.source_exchange_rate], [to.account_currency, d.target_exchange_rate]]) {
      if (cur === BASE && rate !== 1) throw new ErpError(417, 'Exchange rate must be 1 for company-currency account');
      if (!(rate > 0)) throw new ErpError(417, 'Exchange rate is mandatory');
    }
    const basePaid = r2(d.paid_amount * d.source_exchange_rate);
    const baseReceived = r2(d.received_amount * d.target_exchange_rate);
    if (Math.abs(basePaid - baseReceived) > 0.01) {
      throw new ErpError(417, `Difference Amount must be zero (${r2(baseReceived - basePaid)})`);
    }
    const partyAmount = receive ? d.paid_amount : d.received_amount;
    for (const ref of d.references || []) {
      const inv = this.get(ref.reference_doctype, ref.reference_name);
      if (!inv) throw new ErpError(417, `Could not find ${ref.reference_doctype}: ${ref.reference_name}`);
      const invParty = inv.customer || inv.supplier;
      if (invParty !== d.party) throw new ErpError(417, `${ref.reference_name} does not belong to ${d.party}`);
      if (ref.allocated_amount > inv.outstanding_amount + 0.001) {
        throw new ErpError(417, `Allocated Amount ${ref.allocated_amount} cannot be greater than outstanding ${inv.outstanding_amount}`);
      }
      if (ref.allocated_amount > partyAmount + 0.001) throw new ErpError(417, 'Total allocated exceeds paid amount');
    }
    const name = this._seq('ACC-PAY');
    // set_remarks: ERPNext writes its own text over `remarks` unless custom_remarks is ticked.
    const remarks = d.custom_remarks
      ? d.remarks
      : `Amount ${d.paid_from_account_currency || BASE} ${partyAmount} ${receive ? 'received from' : 'paid to'} ${d.party}`;
    const doc = this._put('Payment Entry', { ...d, remarks, name, company: COMPANY, docstatus: d.docstatus || 0 });
    if (doc.docstatus === 1) {
      for (const ref of d.references || []) {
        const inv = this.get(ref.reference_doctype, ref.reference_name);
        inv.outstanding_amount = r2(inv.outstanding_amount - ref.allocated_amount);
      }
      const party = { party_type: d.party_type, party: d.party };
      this._gl('Payment Entry', name, d.posting_date, [
        { account: d.paid_to, dr: d.received_amount, baseDr: baseReceived, ...(receive ? {} : party) },
        { account: d.paid_from, cr: d.paid_amount, baseCr: basePaid, ...(receive ? party : {}) },
      ]);
    }
    return doc;
  }

  /** Batch: one per lot. The document name is the batch_id, unique across the whole site. */
  createBatch(d) {
    if (!d.batch_id) throw new ErpError(417, 'MandatoryError: [Batch]: batch_id');
    if (this.get('Batch', d.batch_id)) {
      throw new ErpError(409, `DuplicateEntryError: ('Batch', '${d.batch_id}', IntegrityError(1062, "Duplicate entry '${d.batch_id}' for key 'PRIMARY'"))`);
    }
    const item = this.get('Item', d.item);
    if (!item) throw new ErpError(417, `Could not find Item: ${d.item}`);
    if (!item.has_batch_no) throw new ErpError(417, `The selected item cannot have Batch`);
    if (d.parent_batch && !this.get('Batch', d.parent_batch)) throw new ErpError(417, `Could not find Parent Batch: ${d.parent_batch}`);
    return this._put('Batch', {
      ...d, name: d.batch_id, description: d.description ?? null, parent_batch: d.parent_batch || null,
      disabled: d.disabled || 0, batch_qty: 0, stock_uom: item.stock_uom || 'Nos',
      // batch.py: decided once, when the batch is made, from the item's valuation method.
      use_batchwise_valuation: this._batchwise(item) ? 1 : 0,
    });
  }

  /**
   * Stock Entry: Material Receipt / Material Issue / Material Transfer / Repack.
   *
   * Deliberately stricter than ERPNext in three places, so a sloppy payload fails here:
   *   - every row must carry expense_account AND cost_center. ERPNext would fall back to company
   *     or item defaults; the design calls that default unreliable, so builders always set both.
   *   - a row must have exactly the warehouses its type calls for (ERPNext silently blanks the
   *     wrong one), and `company` is mandatory.
   *   - rows are stated in the item's stock UOM only.
   * Stock ledger rows are written sources first, then targets, as ERPNext does. All warehouses
   * share the one stock account, so a Material Transfer posts no GL at all.
   */
  createStockEntry(d) {
    const purpose = d.stock_entry_type || d.purpose;
    if (!STOCK_ENTRY_TYPES.includes(purpose)) throw new ErpError(417, `fake-erpnext: Stock Entry type ${purpose} not supported`);
    if (d.stock_entry_type && d.purpose && d.stock_entry_type !== d.purpose) {
      throw new ErpError(417, `Stock Entry Type ${d.stock_entry_type} does not match purpose ${d.purpose}`);
    }
    if (!d.company) throw new ErpError(417, 'MandatoryError: [Stock Entry]: company');
    if (d.set_posting_time && !d.posting_date) throw new ErpError(417, 'MandatoryError: [Stock Entry]: posting_date');
    // As on invoices: posting_date is ignored unless set_posting_time=1; posting_time defaults to now.
    const postingDate = d.set_posting_time ? d.posting_date : TODAY;
    const postingTime = d.posting_time || new Date().toTimeString().slice(0, 8);
    const submit = (d.docstatus || 0) === 1;
    if (!(d.items || []).length) throw new ErpError(417, 'MandatoryError: [Stock Entry]: items');

    const wantSource = purpose !== 'Material Receipt';
    const wantTarget = purpose !== 'Material Issue';
    const rows = d.items.map((it, idx) => {
      const n = idx + 1;
      const item = this.get('Item', it.item_code);
      if (!item) throw new ErpError(417, `Could not find Item: ${it.item_code}`);
      if (!item.is_stock_item) throw new ErpError(417, `Row ${n}: Item ${it.item_code} is not a stock Item`);
      if (!(Number(it.qty) > 0)) throw new ErpError(417, `Row ${n}: Qty is mandatory and must be positive`);
      this._checkWholeQty(item, it.qty, n);
      this._checkRowUom(item, it, n);
      const src = it.s_warehouse || null;
      const tgt = it.t_warehouse || null;
      if (purpose === 'Repack') {
        if (!src && !tgt) throw new ErpError(417, `Row ${n}: Atleast one warehouse is mandatory`);
        if (src && tgt) throw new ErpError(417, `fake-erpnext: Row ${n}: a Repack row is either a source or a target, not both`);
      } else {
        if (wantSource && !src) throw new ErpError(417, `Row ${n}: Source warehouse is mandatory for ${purpose}`);
        if (wantTarget && !tgt) throw new ErpError(417, `Row ${n}: Target warehouse is mandatory for ${purpose}`);
        if (!wantSource && src) throw new ErpError(417, `fake-erpnext: Row ${n}: a ${purpose} row must not have a source warehouse`);
        if (!wantTarget && tgt) throw new ErpError(417, `fake-erpnext: Row ${n}: a ${purpose} row must not have a target warehouse`);
        if (src && src === tgt) throw new ErpError(417, `Row ${n}: Source and target warehouse cannot be same`);
      }
      for (const w of [src, tgt]) if (w) this._checkWarehouse(w, n);
      // Stricter than ERPNext on purpose (see above): no silent default for either.
      if (!it.expense_account) throw new ErpError(417, `Row ${n}: expense_account (Difference Account) is mandatory on every Stock Entry row`);
      if (!it.cost_center) throw new ErpError(417, `Row ${n}: cost_center is mandatory on every Stock Entry row`);
      const acc = this.account(it.expense_account);
      if (acc.company !== COMPANY) throw new ErpError(417, `Row ${n}: Account ${it.expense_account} does not belong to Company ${COMPANY}`);
      if (!this.get('Cost Center', it.cost_center)) throw new ErpError(417, `Row ${n}: Could not find Cost Center: ${it.cost_center}`);
      this._checkBatch(item, it.batch_no, n);
      return { it, item, n, qty: Number(it.qty), src, tgt, batchNo: it.batch_no || null, basic: 0, addl: 0, glAddl: 0 };
    });
    const sources = rows.filter((r) => r.src);
    const targets = rows.filter((r) => r.tgt);
    if (purpose === 'Repack' && !(sources.length && targets.length)) {
      throw new ErpError(417, 'fake-erpnext: a Repack needs at least one source row and one target row');
    }

    const costs = (d.additional_costs || []).map((c, idx) => {
      if (!c.expense_account) throw new ErpError(417, `Additional Costs row ${idx + 1}: expense_account is mandatory`);
      this.account(c.expense_account);
      if (!c.description) throw new ErpError(417, `Additional Costs row ${idx + 1}: description is mandatory`);
      if (!(Number(c.amount) > 0)) throw new ErpError(417, `Additional Costs row ${idx + 1}: amount must be positive`);
      return { ...c, amount: r2(c.amount) };
    });
    if (costs.length && !targets.length) throw new ErpError(417, `fake-erpnext: additional costs on a ${purpose} are not supported`);
    const totalCosts = r2(costs.reduce((n, c) => n + c.amount, 0));

    const head = {
      ...d, company: COMPANY, stock_entry_type: purpose, purpose, posting_date: postingDate, posting_time: postingTime,
      docstatus: d.docstatus || 0, additional_costs: costs, total_additional_costs: totalCosts,
    };
    if (!submit) return this._put('Stock Entry', { ...head, name: this._seq('MAT-STE') });

    // ── value out: each source row leaves at its batch's average in that warehouse ──
    const plan = new StockPlan(this, 'Stock Entry', postingDate, postingTime);
    for (const r of sources) r.out = plan.out({ item: r.item, warehouse: r.src, batchNo: r.batchNo, qty: r.qty });
    const totalOut = r2(sources.reduce((n, r) => n + r.out, 0));

    // ── basic amount of each incoming row ──
    if (purpose === 'Material Transfer') {
      for (const r of targets) r.basic = r.out; // same row: arrives at what it left at
    } else if (purpose === 'Material Receipt') {
      for (const r of targets) {
        if (r.it.basic_amount == null && !(Number(r.it.basic_rate) > 0)) {
          throw new ErpError(417, `ValuationRateMissing: Row ${r.n}: Valuation Rate for the Item ${r.item.name} is required (send basic_rate or basic_amount)`);
        }
        r.basic = r.it.basic_amount != null ? r2(r.it.basic_amount) : r2(r.qty * r.it.basic_rate);
      }
    } else {
      // Repack. A target row keeps its own value only with set_basic_rate_manually AND a
      // basic_amount (or allow_zero_valuation_rate, for a row worth nothing). Any other target
      // row is valued by ERPNext itself, "by weight": the total outgoing value divided by the
      // total quantity of ALL target rows (unrounded rate, as get_basic_rate_for_repacked_items
      // does), times the row's quantity. This is the default the design warns about.
      // A manual row that also states a basic_rate is valued from the RATE, as ERPNext does
      // (basic_amount = qty x basic_rate): a rate rounded to 2 places shows up as a wrong value.
      const manual = (r) => !!r.it.set_basic_rate_manually && (Number(r.it.basic_amount) > 0 || !!r.it.allow_zero_valuation_rate);
      const stated = (r) => (Number(r.it.basic_rate) > 0 ? r2(r.qty * r.it.basic_rate) : r2(r.it.basic_amount || 0));
      const targetQty = targets.reduce((n, r) => n + r.qty, 0);
      for (const r of targets) r.basic = manual(r) ? stated(r) : r2(r.qty * totalOut / targetQty);
    }
    const totalBasic = r2(targets.reduce((n, r) => n + r.basic, 0));

    // ── additional costs: spread over the incoming rows in proportion to their basic amounts and
    // added to their value; the last row takes the remainder so the shares sum to the total. With
    // no basic amount to spread over, ERPNext leaves stock alone and the cost lands in the rows'
    // expense accounts (shared by quantity).
    if (totalCosts) {
      const weight = (r) => (totalBasic > 0 ? r.basic / totalBasic : r.qty / targets.reduce((n, t) => n + t.qty, 0));
      let left = totalCosts;
      targets.forEach((r, i) => {
        r.glAddl = i === targets.length - 1 ? r2(left) : r2(totalCosts * weight(r));
        left = r2(left - r.glAddl);
        if (totalBasic > 0) r.addl = r.glAddl;
      });
    }
    for (const r of targets) {
      r.amount = r2(r.basic + r.addl);
      plan.in({ item: r.item, warehouse: r.tgt, batchNo: r.batchNo, qty: r.qty, value: r.amount });
    }
    const totalIn = r2(targets.reduce((n, r) => n + r.amount, 0));

    // ── GL, netted per account (Dr positive). Per ledger row: stock account against the row's
    // expense_account. Per additional cost: Cr its own account, Dr the target rows' expense
    // accounts. What is left on an expense account is the value difference of the entry.
    const net = new Map();
    const post = (account, amount) => net.set(account, r2((net.get(account) || 0) + amount));
    if (purpose !== 'Material Transfer' || totalCosts) {
      for (const r of sources) {
        post(STOCK_ACCOUNT, -r.out);
        post(r.it.expense_account, r.out);
      }
      for (const r of targets) {
        post(STOCK_ACCOUNT, r.amount);
        post(r.it.expense_account, r2(r.glAddl - r.amount));
      }
      for (const c of costs) post(c.expense_account, -c.amount);
    }
    const gl = [...net].filter(([, amount]) => amount)
      .map(([account, amount]) => (amount > 0 ? { account, dr: amount, baseDr: amount } : { account, cr: -amount, baseCr: -amount }));

    const perUnit = (value, qty) => Number((value / qty).toFixed(6));
    const name = this._seq('MAT-STE');
    const doc = this._put('Stock Entry', {
      ...head, name,
      items: rows.map((r) => {
        const basic = r.tgt ? r.basic : r.out;
        const amount = r.tgt ? r.amount : r.out;
        return {
          ...r.it, s_warehouse: r.src, t_warehouse: r.tgt, batch_no: r.batchNo,
          basic_rate: perUnit(basic, r.qty), basic_amount: basic, additional_cost: r.addl,
          amount, valuation_rate: perUnit(amount, r.qty),
        };
      }),
      total_outgoing_value: totalOut, total_incoming_value: totalIn, value_difference: r2(totalIn - totalOut),
    });
    plan.commit(name);
    this._gl('Stock Entry', name, postingDate, gl);
    return doc;
  }

  /**
   * PUT /api/resource/<doctype>/<name>: merge fields into a stored document. Like Frappe, a
   * submitted document cannot be edited (the fake knows no allow-on-submit fields) and a cancelled
   * one not at all; submitting or cancelling through PUT is not modelled.
   */
  update(doctype, name, d) {
    const doc = this.get(doctype, name);
    if (!doc) throw new ErpError(404, `DoesNotExistError: ${doctype} ${name} not found`);
    const changed = Object.keys(d).filter((k) => JSON.stringify(d[k]) !== JSON.stringify(doc[k]));
    if (changed.includes('name')) throw new ErpError(417, 'fake-erpnext: renaming through PUT is not supported');
    if (doc.docstatus === 2) throw new ErpError(417, 'Cannot edit cancelled document');
    if (changed.includes('docstatus')) throw new ErpError(417, 'fake-erpnext: changing docstatus through PUT is not supported; create with docstatus 1, cancel with frappe.client.cancel');
    if (doc.docstatus === 1 && changed.length) {
      throw new ErpError(417, `UpdateAfterSubmitError: Not allowed to change ${changed.join(', ')} after submission`);
    }
    if (doctype === 'Item') {
      const hasLedger = this.all('Stock Ledger Entry').some((e) => e.item_code === name);
      const frozen = changed.filter((k) => ITEM_FROZEN_FIELDS.includes(k) && String(d[k] ?? '') !== String(doc[k] ?? ''));
      if (hasLedger && frozen.length) {
        throw new ErpError(417, `As there are existing transactions against item ${name}, you can not change the value of ${frozen.join(', ')}`);
      }
      if (changed.includes('stock_uom') && !this.get('UOM', d.stock_uom)) throw new ErpError(417, `Could not find UOM: ${d.stock_uom}`);
    }
    if (doctype === 'Batch' && (changed.includes('batch_id') || changed.includes('item'))) {
      throw new ErpError(417, `Cannot change ${changed.includes('item') ? 'Item' : 'Batch ID'} of Batch ${name} after it is created`);
    }
    return Object.assign(doc, d);
  }

  /**
   * frappe.client.cancel: docstatus 1 → 2 and the document's effect taken back out. Its stock
   * ledger rows are marked is_cancelled (Bins and batches recomputed without them); its GL rows
   * are marked is_cancelled and mirrored by reversed rows, also is_cancelled, as ERPNext does, so
   * the voucher nets to zero and no balance query (they all filter is_cancelled = 0) sees it.
   * Refused when a submitted Payment Entry still points at the invoice, when the stock the
   * document brought in was used later (a batch or item would go below zero), and, a limit of the
   * fake, when a later issue would have to be revalued. Everything is checked before anything is
   * touched.
   */
  cancel(doctype, name) {
    if (!CANCELLABLE.includes(doctype)) throw new ErpError(417, `fake-erpnext: cancel ${doctype} not supported`);
    const doc = this.get(doctype, name);
    if (!doc) throw new ErpError(404, `DoesNotExistError: ${doctype} ${name} not found`);
    if (doc.docstatus === 2) throw new ErpError(417, `${doctype} ${name} is already cancelled`);
    if (doc.docstatus !== 1) throw new ErpError(417, `DocstatusTransitionError: Cannot change docstatus from 0 (Draft) to 2 (Cancelled)`);

    const isInvoice = doctype === 'Sales Invoice' || doctype === 'Purchase Invoice';
    if (isInvoice) {
      // The design's undo order: the payment goes first. (A stock ERPNext can be set to unlink
      // payments instead; the fake always refuses.)
      const pay = this.all('Payment Entry').find((p) => p.docstatus === 1
        && (p.references || []).some((r) => r.reference_doctype === doctype && r.reference_name === name));
      if (pay) throw new ErpError(417, `LinkExistsError: Cannot cancel ${doctype} ${name} because it is linked with submitted Payment Entry ${pay.name}`);
    }

    // Taking this document's receipts back out must not leave any batch (or non-batch item)
    // below zero in a warehouse at any point: that means something later consumed the stock.
    const sles = this.all('Stock Ledger Entry').filter((e) => e.voucher_type === doctype && e.voucher_no === name && !e.is_cancelled);
    if (!this.get('Stock Settings', 'Stock Settings')?.allow_negative_stock) {
      const seen = new Set();
      for (const e of sles.filter((x) => x.actual_qty > 0)) {
        const key = `${e.item_code}|${e.batch_no}|${e.warehouse}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const min = this._minBalance({ itemCode: e.item_code, warehouse: e.warehouse, batchNo: e.batch_no, excludeVoucher: { doctype, name } });
        if (min < -0.0000005) {
          throw new ErpError(417, `Cannot cancel ${doctype} ${name}, its stock was used by a later transaction. ${this._negativeStockMessage(rq(-min), e.item_code, e.batch_no, e.warehouse, e.posting_date)}`);
        }
      }
    }

    // ERPNext would now revalue ("repost") every later entry. The fake does not, so rather than
    // leave books ERPNext would not have, it refuses a cancel that changes a later issue's value.
    const drift = this._wouldRevalue(sles);
    if (drift) {
      throw new ErpError(417, `fake-erpnext: cannot cancel ${doctype} ${name}: ${drift.voucher_type} ${drift.voucher_no} issued Item ${drift.item_code}`
        + `${drift.batch_no ? `, Batch ${drift.batch_no}` : ''} from Warehouse ${drift.warehouse} afterwards and would have to be revalued (reposting is not modelled). Cancel the later document first.`);
    }

    if (doctype === 'Payment Entry') {
      for (const ref of doc.references || []) {
        const inv = this.get(ref.reference_doctype, ref.reference_name);
        if (inv) inv.outstanding_amount = r2(inv.outstanding_amount + ref.allocated_amount);
      }
    }
    for (const e of sles) e.is_cancelled = 1;
    this._refreshStock(sles);
    for (const g of this.all('GL Entry').filter((x) => x.voucher_type === doctype && x.voucher_no === name && !x.is_cancelled)) {
      g.is_cancelled = 1;
      this._put('GL Entry', {
        ...g, name: this._seq('GLE'), remarks: `On cancellation of ${name}`,
        debit: g.credit, credit: g.debit,
        debit_in_account_currency: g.credit_in_account_currency, credit_in_account_currency: g.debit_in_account_currency,
      });
    }
    doc.docstatus = 2;
    return doc;
  }

  /**
   * Would cancelling the document that owns `sles` change what a remaining issue is worth? Each
   * batch + warehouse (item + warehouse for moving-average items) the document touched is
   * replayed without it, valuing every issue the way it was valued when posted. Returns the first
   * ledger row whose value would no longer match, or null.
   */
  _wouldRevalue(sles) {
    const mine = new Set(sles);
    const seen = new Set();
    for (const s of sles) {
      const item = this.get('Item', s.item_code);
      const batchwise = !!(s.batch_no && item && this._batchwise(item));
      const key = `${batchwise ? `b|${s.batch_no}` : `i|${s.item_code}`}|${s.warehouse}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rows = this.all('Stock Ledger Entry').filter((e) => !e.is_cancelled && !mine.has(e) && e.warehouse === s.warehouse
        && (batchwise ? e.batch_no === s.batch_no : e.item_code === s.item_code));
      if (batchwise) {
        let qty = 0, value = 0;
        for (const e of rows) {
          if (e.actual_qty < 0) {
            const rate = qty > 0 ? value / qty : (item.valuation_rate || 0);
            const expected = rq(qty + e.actual_qty) === 0 ? value : r2(-e.actual_qty * rate);
            if (Math.abs(expected + e.stock_value_difference) > 0.005) return e;
          }
          qty = rq(qty + e.actual_qty);
          value = r2(value + e.stock_value_difference);
        }
      } else {
        let bin = { qty: 0, rate: 0 };
        for (const e of rows) {
          if (e.actual_qty < 0 && Math.abs(r2(-e.actual_qty * bin.rate) + e.stock_value_difference) > 0.005) return e;
          bin = movingAverage(bin, e);
        }
      }
    }
    return null;
  }

  /**
   * erpnext.stock.doctype.batch.batch.get_batch_qty. batch + warehouse → a number; batch alone →
   * [{ batch_no, warehouse, qty }] for the warehouses holding it; warehouse + item_code without a
   * batch → [{ batch_no, qty }]. An unknown batch is simply empty, as in ERPNext.
   */
  getBatchQty({ batch_no: batchNo, warehouse, item_code: itemCode }) {
    const live = this.all('Stock Ledger Entry').filter((e) => !e.is_cancelled && e.batch_no);
    const sumBy = (rows, keyOf) => {
      const out = new Map();
      for (const e of rows) out.set(keyOf(e), rq((out.get(keyOf(e)) || 0) + e.actual_qty));
      return [...out].filter(([, qty]) => qty);
    };
    if (batchNo && warehouse) return this.batchValue(batchNo, warehouse).qty;
    if (batchNo) return sumBy(live.filter((e) => e.batch_no === batchNo), (e) => e.warehouse).map(([w, qty]) => ({ batch_no: batchNo, warehouse: w, qty }));
    if (warehouse && itemCode) {
      return sumBy(live.filter((e) => e.warehouse === warehouse && e.item_code === itemCode), (e) => e.batch_no).map(([b, qty]) => ({ batch_no: b, qty }));
    }
    throw new ErpError(417, 'fake-erpnext: get_batch_qty needs batch_no, or warehouse and item_code');
  }

  create(doctype, d) {
    if (d.company && d.company !== COMPANY) throw new ErpError(417, `Company ${d.company} not found`);
    switch (doctype) {
      case 'Account': return this.createAccount(d);
      case 'Customer':
      case 'Supplier': return this.createParty(doctype, d);
      case 'Item':
        if (this.get('Item', d.item_code)) throw new ErpError(409, `DuplicateEntryError: Item ${d.item_code} already exists`);
        // item_group is mandatory in ERPNext; other suites seed bare Items directly, so only
        // reject a group that doesn't exist.
        if (d.item_group && !this.get('Item Group', d.item_group)) throw new ErpError(417, `Could not find Item Group: ${d.item_group}`);
        if (d.stock_uom && !this.get('UOM', d.stock_uom)) throw new ErpError(417, `Could not find UOM: ${d.stock_uom}`);
        // has_batch_no / create_new_batch / valuation_method / stock_uom are stored as sent.
        return this._put('Item', { ...d, name: d.item_code });
      case 'UOM':
        if (!d.uom_name) throw new ErpError(417, 'MandatoryError: [UOM]: uom_name');
        if (this.get('UOM', d.uom_name)) throw new ErpError(409, `DuplicateEntryError: UOM ${d.uom_name} already exists`);
        return this._put('UOM', { enabled: 1, must_be_whole_number: 0, ...d, name: d.uom_name });
      case 'Batch': return this.createBatch(d);
      case 'Stock Entry': return this.createStockEntry(d);
      case 'Item Group':
        if (!this.get('Item Group', d.parent_item_group)) throw new ErpError(417, `Could not find Item Group: ${d.parent_item_group}`);
        return this._put('Item Group', { ...d, name: d.item_group_name });
      case 'Company':
        // Just the record (scripts/provision-user.js): the fake's chart is seeded for COMPANY only.
        if (this.get('Company', d.company_name)) throw new ErpError(409, `DuplicateEntryError: Company ${d.company_name} already exists`);
        if (this.all('Company').some((c) => c.abbr === d.abbr)) throw new ErpError(417, `Abbreviation ${d.abbr} is already used for another company`);
        return this._put('Company', { ...d, name: d.company_name, default_inventory_account: d.company_name === COMPANY ? STOCK_ACCOUNT : null });
      case 'Warehouse':
        if (this.get('Warehouse', `${d.warehouse_name} - ${(this.get('Company', d.company) || {}).abbr || ABBR}`)) {
          throw new ErpError(409, `DuplicateEntryError: Warehouse ${d.warehouse_name} already exists`);
        }
        return this._put('Warehouse', { ...d, name: `${d.warehouse_name} - ${(this.get('Company', d.company) || {}).abbr || ABBR}`, is_group: d.is_group || 0 });
      case 'Sales Invoice':
      case 'Purchase Invoice': return this.createInvoice(doctype, d);
      case 'Journal Entry': return this.createJournalEntry(d);
      case 'Payment Entry': return this.createPaymentEntry(d);
      case 'Comment':
        // Stock Comment doctype: the referenced document must exist (Dynamic Link validation).
        if (!this.get(d.reference_doctype, d.reference_name)) {
          throw new ErpError(417, `Could not find ${d.reference_doctype}: ${d.reference_name}`);
        }
        return this._put('Comment', { ...d, name: this._seq('CMT') });
      default:
        if (this.createHandlers[doctype]) return this._put(doctype, this.createHandlers[doctype](d));
        throw new ErpError(417, `fake-erpnext: create ${doctype} not supported`);
    }
  }

  balanceOn(account, date) {
    return r2(this.all('GL Entry')
      .filter((g) => g.account === account && g.posting_date <= date && !g.is_cancelled)
      .reduce((s, g) => s + g.debit_in_account_currency - g.credit_in_account_currency, 0));
  }

  // ── HTTP surface ────────────────────────────────────────────────────
  handle(method, url, body) {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'api' && parts[1] === 'method') {
      if (this.methods[parts[2]]) return this.methods[parts[2]](u, body);
      // Arguments arrive in the query string (GET) or the JSON body (POST).
      const arg = (k) => u.searchParams.get(k) ?? (body && body[k] != null ? body[k] : null);
      if (parts[2] === 'erpnext.accounts.utils.get_balance_on') {
        return { message: this.balanceOn(arg('account'), arg('date')) };
      }
      if (parts[2] === 'erpnext.stock.doctype.batch.batch.get_batch_qty') {
        return { message: this.getBatchQty({ batch_no: arg('batch_no'), warehouse: arg('warehouse'), item_code: arg('item_code') }) };
      }
      if (parts[2] === 'frappe.client.cancel') {
        // Whitelisted for POST (and PUT) only.
        if (method === 'GET') throw new ErpError(403, 'PermissionError: frappe.client.cancel is not allowed with GET');
        return { message: this.cancel(arg('doctype'), arg('name')) };
      }
      throw new ErpError(404, `fake-erpnext: method ${parts[2]} not supported`);
    }
    if (parts[0] !== 'api' || parts[1] !== 'resource') throw new ErpError(404, 'not found');
    const doctype = parts[2];
    const name = parts[3];

    if (method === 'PUT' && name) return { data: this.update(doctype, name, body || {}) };
    if (method === 'POST') return { data: this.create(doctype, body) };
    if (method === 'GET' && name) {
      const doc = this.get(doctype, name);
      if (!doc) throw new ErpError(404, `DoesNotExistError: ${doctype} ${name} not found`);
      return { data: doc };
    }
    if (method === 'GET') {
      const filters = JSON.parse(u.searchParams.get('filters') || '[]');
      const fields = JSON.parse(u.searchParams.get('fields') || '["name"]');
      const limit = Number(u.searchParams.get('limit_page_length') || 20);
      // A Journal Entry keeps its text in user_remark; it has no `remarks` column to filter on.
      if (doctype === 'Journal Entry' && filters.some((f) => f[0] === 'remarks')) {
        throw new ErpError(417, "DataError: Field not permitted in query: remarks");
      }
      let rows = this.all(doctype).filter((d) => filters.every((f) => matchFilter(d, f)));
      const order = u.searchParams.get('order_by');
      if (order) {
        const [f, dir] = order.split(' ');
        rows.sort((a, b) => String(a[f]).localeCompare(String(b[f])) * (dir === 'desc' ? -1 : 1));
      }
      if (limit) rows = rows.slice(0, limit);
      return { data: rows.map((d) => Object.fromEntries(fields.map((f) => [f, d[f] ?? null]))) };
    }
    throw new ErpError(405, `fake-erpnext: ${method} not supported`);
  }

  install() {
    global.fetch = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      this.calls.push({ method, url, body });
      let status = 200, payload;
      try {
        payload = this.handle(method, url, body);
      } catch (err) {
        if (!(err instanceof ErpError)) throw err;
        status = err.status;
        payload = { exception: err.message };
      }
      return { ok: status < 300, status, text: async () => JSON.stringify(payload) };
    };
  }
}

module.exports = { FakeErpNext, COMPANY, BASE, TODAY };
