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
 * Submitted documents post GL Entries, so balance / ledger queries read real results.
 */
const COMPANY = 'Test Co';
const ABBR = 'TC';
const BASE = 'THB';
const TODAY = new Date().toISOString().slice(0, 10);

function r2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
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
    A('5216', 'Travel Expenses', { root_type: 'Expense' }),
    A('5223', 'Miscellaneous Expenses', { root_type: 'Expense' }),
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
    for (const a of seedAccounts()) this._put('Account', a);
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
    let total = 0;
    for (const it of d.items || []) {
      const item = this.get('Item', it.item_code);
      if (!item) throw new ErpError(417, `Could not find Item: ${it.item_code}`);
      if (isSales && !item.is_sales_item) throw new ErpError(417, `Item ${it.item_code} is not a sales Item`);
      if (!isSales && !item.is_purchase_item) throw new ErpError(417, `Item ${it.item_code} is not a purchase Item`);
      total += it.qty * it.rate;
    }
    const name = this._seq(isSales ? 'ACC-SINV' : 'ACC-PINV');
    const doc = this._put(doctype, {
      ...d, name, company: COMPANY, posting_date: postingDate, [accField]: partyAccount,
      conversion_rate: rate, grand_total: r2(total), outstanding_amount: r2(total),
      party_account_currency: acc.account_currency, docstatus: d.docstatus || 0,
      [isSales ? 'customer_name' : 'supplier_name']: this.get(partyType, d[partyField])[isSales ? 'customer_name' : 'supplier_name'],
    });
    if (doc.docstatus === 1) {
      const base = r2(total * rate);
      const lineAcc = isSales ? d.items[0].income_account : d.items[0].expense_account;
      if (!lineAcc) throw new ErpError(417, `${isSales ? 'Income' : 'Expense'} account missing on item row`);
      this.account(lineAcc);
      const partyRow = { account: partyAccount, party_type: partyType, party: d[partyField] };
      if (isSales) {
        this._gl(doctype, name, postingDate, [
          { ...partyRow, dr: r2(total), baseDr: base },
          { account: lineAcc, cr: base, baseCr: base, against: d[partyField] },
        ]);
      } else {
        this._gl(doctype, name, postingDate, [
          { account: lineAcc, dr: base, baseDr: base, against: d[partyField] },
          { ...partyRow, cr: r2(total), baseCr: base },
        ]);
      }
    }
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
      case 'Item': return this._put('Item', { ...d, name: d.item_code });
      case 'Sales Invoice':
      case 'Purchase Invoice': return this.createInvoice(doctype, d);
      case 'Journal Entry': return this.createJournalEntry(d);
      case 'Payment Entry': return this.createPaymentEntry(d);
      default: throw new ErpError(417, `fake-erpnext: create ${doctype} not supported`);
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
