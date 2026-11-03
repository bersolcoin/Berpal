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
 * Submitted documents post GL Entries, so balance / ledger queries read real results.
 */
const COMPANY = 'Test Co';
const ABBR = 'TC';
const BASE = 'THB';
const TODAY = new Date().toISOString().slice(0, 10);
const STOCK_ACCOUNT = `1410 - Stock In Hand - ${ABBR}`;
const ROUND_OFF_ACCOUNT = `5225 - Round Off - ${ABBR}`;
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
    A('5111', 'Cost of Goods Sold', { root_type: 'Expense' }),
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
      const re = new RegExp(`^${String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i');
      return re.test(String(v ?? ''));
    }
    default: throw new ErpError(417, `fake-erpnext: unsupported filter op ${op}`);
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
    this._put('Company', { name: COMPANY, abbr: ABBR, default_currency: BASE, default_inventory_account: STOCK_ACCOUNT });
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
      // UOM Nos has must_be_whole_number=1.
      if ((item.stock_uom || 'Nos') === 'Nos' && !Number.isInteger(Number(it.qty))) {
        throw new ErpError(417, `Row ${idx + 1}: Quantity (${it.qty}) cannot be a fraction. To allow this, disable 'Must be Whole Number' in UOM Nos.`);
      }
      const amount = r2(it.qty * r2(it.rate));
      total += amount;
      const stock = !!(item.is_stock_item && d.update_stock);
      const warehouse = it.warehouse || d.set_warehouse || null;
      if (stock) {
        if (!warehouse) throw new ErpError(417, `Row ${idx + 1}: Warehouse is mandatory for stock Item ${it.item_code}`);
        const w = this.get('Warehouse', warehouse);
        if (!w || w.company !== COMPANY || w.is_group) throw new ErpError(417, `Row ${idx + 1}: invalid Warehouse ${warehouse}`);
      }
      lines.push({ it, item, amount, stock, warehouse });
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
    if (submit) {
      const pending = new Map();
      for (const l of lines.filter((x) => x.stock)) {
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
      if (isSales) {
        const cost = r2(l.it.qty * bin.valuation_rate);
        const cogs = l.it.expense_account || `5111 - Cost of Goods Sold - ${ABBR}`;
        this.account(cogs);
        gl.push({ account: cogs, dr: cost, baseDr: cost }, { account: STOCK_ACCOUNT, cr: cost, baseCr: cost });
        bin.actual_qty = r2(bin.actual_qty - l.it.qty);
      } else {
        const inValue = base(l.net);
        const qty = r2(bin.actual_qty + l.it.qty);
        bin.valuation_rate = qty > 0 ? r2((bin.actual_qty * bin.valuation_rate + inValue) / qty) : bin.valuation_rate;
        bin.actual_qty = qty;
      }
      bin.stock_value = r2(bin.actual_qty * bin.valuation_rate);
      this._put('Stock Ledger Entry', {
        name: this._seq('SLE'), item_code: l.it.item_code, warehouse: l.warehouse, posting_date: postingDate,
        posting_time: postingTime, creation: new Date().toISOString(), actual_qty: isSales ? -l.it.qty : l.it.qty, voucher_type: doctype, voucher_no: name, is_cancelled: 0,
      });
    }
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
    const doc = this._put('Payment Entry', { ...d, name, company: COMPANY, docstatus: d.docstatus || 0 });
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
        return this._put('Item', { ...d, name: d.item_code });
      case 'Item Group':
        if (!this.get('Item Group', d.parent_item_group)) throw new ErpError(417, `Could not find Item Group: ${d.parent_item_group}`);
        return this._put('Item Group', { ...d, name: d.item_group_name });
      case 'Sales Invoice':
      case 'Purchase Invoice': return this.createInvoice(doctype, d);
      case 'Journal Entry': return this.createJournalEntry(d);
      case 'Payment Entry': return this.createPaymentEntry(d);
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
      if (parts[2] === 'erpnext.accounts.utils.get_balance_on') {
        return { message: this.balanceOn(u.searchParams.get('account'), u.searchParams.get('date')) };
      }
      throw new ErpError(404, `fake-erpnext: method ${parts[2]} not supported`);
    }
    if (parts[0] !== 'api' || parts[1] !== 'resource') throw new ErpError(404, 'not found');
    const doctype = parts[2];
    const name = parts[3];

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
