/**
 * End-to-end tool flows against an in-memory ERPNext (test/fake-erpnext.js) and Postgres (pg-mem).
 * Drives the same executeTool() entry point the LLM uses. Steps share state and run in order.
 *
 *   npm test
 */
process.env.ERPNEXT_URL = 'http://erp.test';
delete process.env.OPENAI_API_KEY;

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { FakeErpNext, COMPANY, TODAY } = require('./fake-erpnext');
const db = require('../src/db');
const { TOOLS, executeTool } = require('../src/tools');

const erp = new FakeErpNext();
let user;
const ids = {};

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Run one tool with a fresh per-turn ctx, like conversation.handle does. */
async function tool(name, args = {}, draft = {}) {
  const ctx = { user, draft: { ...draft }, saved: null, cancelled: false, confirmationRequested: false };
  const result = await executeTool(name, args, ctx);
  return { result, ctx };
}

/** update_draft → request_confirmation → save_transaction, asserting each step succeeds. */
async function confirmAndSave(draft) {
  const confirm = await tool('request_confirmation', {}, draft);
  assert.equal(confirm.result.ok, true, `request_confirmation: ${confirm.result.error}`);
  const { result } = await tool('save_transaction', {}, draft);
  assert.equal(result.ok, true, `save_transaction: ${result.error}`);
  return result;
}

function walletBalance(name) {
  return erp.balanceOn(`${name} - TC`, TODAY);
}

before(async () => {
  erp.install();
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
  const now = new Date().toISOString();
  const r = await db.query(
    `INSERT INTO users (phone, erpnext_company, erpnext_api_key, erpnext_api_secret,
       default_currency, reporting_currency, country, created_at, updated_at)
     VALUES ('+66000', $1, 'k', 's', 'THB', 'THB', 'TH', $2, $2) RETURNING *`,
    [COMPANY, now]
  );
  user = r.rows[0];
});

test('every tool the system prompt tells the model to call exists', async () => {
  const prompt = require('fs').readFileSync(require.resolve('../src/conversation.js'), 'utf8');
  const names = new Set(TOOLS.map((t) => t.function.name));
  const referenced = new Set(prompt.match(/\b(?:query|lookup|list|create|fetch|update|request|save|cancel)_[a-z_]+(?=\()/g));
  for (const n of ['query_open_invoices', 'query_balance_with_counterparty', 'query_upcoming',
    'query_transaction_summary', 'query_cash_bank_balance', 'lookup_counterparty', 'create_contact',
    'list_user_accounts', 'create_user_account', ...referenced]) {
    assert.ok(names.has(n), `prompt references ${n} but no such tool`);
  }
  assert.equal(names.size, TOOLS.length, 'duplicate tool names');
});

test('wallets: ERPNext cash account is listed; create is idempotent', async () => {
  let { result } = await tool('list_user_accounts');
  assert.deepEqual(result.accounts.map((w) => [w.name, w.type, w.currency]), [['Cash', 'Cash', 'THB']]);
  ids.cash = result.accounts[0].id;

  ({ result } = await tool('create_user_account', { name: 'BBL Savings', parent_code: '1100', currency: 'THB' }));
  assert.equal(result.existed, false);
  ids.bbl = result.wallet.id;
  assert.equal(erp.get('Account', 'BBL Savings - TC').parent_account, '1200 - Bank Accounts - TC');

  ({ result } = await tool('create_user_account', { name: 'bbl savings', parent_code: '1100', currency: 'THB' }));
  assert.equal(result.existed, true);
  assert.equal(result.wallet.id, ids.bbl);

  ({ result } = await tool('create_user_account', { name: 'DBS USD', parent_code: '1100', currency: 'USD' }));
  ids.dbs = result.wallet.id;
  ({ result } = await tool('create_user_account', { name: 'AmEx', parent_code: '2100', currency: 'THB' }));
  ids.amex = result.wallet.id;
  assert.equal(erp.get('Account', 'AmEx - TC').root_type, 'Liability');

  ({ result } = await tool('list_user_accounts', { currency: 'THB', parentCodes: ['1000', '1100'] }));
  assert.deepEqual(result.accounts.map((w) => w.name).sort(), ['BBL Savings', 'Cash']);
});

test('opening balance → JE against Opening Balance Equity', async () => {
  const r = await confirmAndSave({
    transaction_type: 'cash', direction: 'income', amount: 50000, currency: 'THB',
    transaction_date: TODAY, category_code: '3200', payment_account_id: ids.bbl, description: 'Opening balance',
  });
  assert.equal(r.doctype, 'Journal Entry');
  assert.equal(walletBalance('BBL Savings'), 50000);
  assert.equal(erp.balanceOn('3300 - Opening Balance Equity - TC', TODAY), -50000);
});

test('cash expense: wallet is mandatory, then posts Dr expense / Cr wallet', async () => {
  const draft = {
    transaction_type: 'cash', direction: 'expense', amount: 850, currency: 'THB',
    transaction_date: TODAY, category_code: '5100', description: 'lunch',
  };
  const { result } = await tool('request_confirmation', {}, draft);
  assert.equal(result.ok, false);
  assert.match(result.error, /list_user_accounts/);

  await confirmAndSave({ ...draft, payment_account_id: ids.cash });
  assert.equal(walletBalance('1110 - Cash'), -850);
  assert.equal(erp.balanceOn('5204 - Entertainment Expenses - TC', TODAY), 850);
});

test('credit card expense posts to the card liability', async () => {
  await confirmAndSave({
    transaction_type: 'cash', direction: 'expense', amount: 1200, currency: 'THB',
    transaction_date: TODAY, category_code: '5200', payment_account_id: ids.amex,
  });
  assert.equal(walletBalance('AmEx'), -1200);
});

test('transfer between wallets, and same-wallet transfer is rejected', async () => {
  const draft = {
    transaction_type: 'cash', direction: 'transfer', amount: 5000, currency: 'THB', transaction_date: TODAY,
    payment_account_id: ids.bbl, transfer_destination_account_id: ids.cash,
  };
  await confirmAndSave(draft);
  assert.equal(walletBalance('BBL Savings'), 45000);
  assert.equal(walletBalance('1110 - Cash'), 4150);

  const { result } = await tool('save_transaction', {}, { ...draft, transfer_destination_account_id: ids.bbl });
  assert.equal(result.ok, false);
  assert.match(result.error, /same wallet/);
});

test('USD sales invoice to a new customer: contact ask, back-dating, per-currency debtors', async () => {
  const backDate = addDays(TODAY, -20);
  const draft = {
    transaction_type: 'invoice_issued', direction: 'income', amount: 45000, currency: 'USD',
    transaction_date: backDate, category_code: '4000', counterparty_name: 'Jameel Crest Gems',
    payment_terms: 'net_30', description: 'ruby 7.68ct',
  };
  let { result } = await tool('request_confirmation', {}, draft);
  assert.match(result.error, /exchange_rate/);
  ({ result } = await tool('request_confirmation', {}, { ...draft, exchange_rate: 32.5 }));
  assert.match(result.error, /new counterparty/);

  const saved = await confirmAndSave({ ...draft, exchange_rate: 32.5, counterparty_contact_skipped: true });
  ids.sinv = saved.erpnext_name;
  const inv = erp.get('Sales Invoice', ids.sinv);
  assert.equal(inv.posting_date, backDate, 'posting date must not be reset to today');
  assert.equal(inv.due_date, addDays(backDate, 30));
  assert.equal(inv.debit_to, 'Debtors USD - TC');
  assert.equal(erp.balanceOn('4110 - Sales - TC', TODAY), -1462500);
});

test('lookup_counterparty finds by fragment and flags exact matches', async () => {
  let { result } = await tool('lookup_counterparty', { search: 'jameel' });
  assert.equal(result.count, 1);
  assert.equal(result.matches[0].exact, false);
  assert.equal(result.matches[0].is_customer, true);
  ids.jameel = result.matches[0].id;
  ({ result } = await tool('lookup_counterparty', { search: 'Jameel Crest Gems' }));
  assert.equal(result.matches[0].exact, true);
});

test('query_open_invoices returns refs, totals and overdue info', async () => {
  const { result } = await tool('query_open_invoices', { direction: 'receivable', counterparty_id: ids.jameel });
  assert.equal(result.total_count, 1);
  const row = result.rows[0];
  assert.equal(row.ref, ids.sinv);
  assert.equal(row.doctype, 'Sales Invoice');
  assert.equal(row.days_until_due, 10);
  assert.equal(row.base_outstanding, 1462500);
  assert.deepEqual(result.totals_by_currency, { receivable: { USD: 45000 } });
});

test('payment: wrong currency is refused; settles USD invoice into USD bank at a new rate', async () => {
  const draft = {
    transaction_type: 'payment', direction: 'income', amount: 45000, currency: 'USD', transaction_date: TODAY,
    parent_invoice_name: ids.sinv, parent_invoice_doctype: 'Sales Invoice', counterparty_id: ids.jameel,
    exchange_rate: 33, payment_account_id: ids.dbs,
  };
  let { result } = await tool('save_transaction', {}, { ...draft, currency: 'THB', exchange_rate: undefined });
  assert.equal(result.ok, false);
  assert.match(result.error, /balance is in USD/);

  result = await confirmAndSave(draft);
  assert.equal(result.doctype, 'Payment Entry');
  assert.equal(result.settles, ids.sinv);
  assert.equal(erp.get('Sales Invoice', ids.sinv).outstanding_amount, 0);
  assert.equal(walletBalance('DBS USD'), 45000);
  const pe = erp.get('Payment Entry', result.erpnext_name);
  assert.equal(pe.reference_no.startsWith('WA-'), true, 'bank payments need a reference no');

  ({ result } = await tool('query_open_invoices', { direction: 'receivable' }));
  assert.equal(result.total_count, 0);
});

test('payment: USD invoice settled into a THB wallet converts at the rate', async () => {
  const inv = await confirmAndSave({
    transaction_type: 'invoice_issued', direction: 'income', amount: 1000, currency: 'USD', exchange_rate: 32.5,
    transaction_date: TODAY, category_code: '4000', counterparty_id: ids.jameel, payment_terms: 'net_7',
  });
  await confirmAndSave({
    transaction_type: 'payment', direction: 'income', amount: 400, currency: 'USD', exchange_rate: 33,
    transaction_date: TODAY, parent_invoice_name: inv.erpnext_name, payment_account_id: ids.bbl,
  });
  assert.equal(erp.get('Sales Invoice', inv.erpnext_name).outstanding_amount, 600, 'partial payment');
  assert.equal(walletBalance('BBL Savings'), 45000 + 13200);
});

test('bill from a supplier, then paid in full from the bank', async () => {
  const bill = await confirmAndSave({
    transaction_type: 'bill_received', direction: 'expense', amount: 12000, currency: 'THB',
    transaction_date: TODAY, category_code: '5000', counterparty_name: 'Acme Supplies',
    counterparty_phone: '+66111', payment_terms: 'net_15', invoice_number: 'ACME-77', description: 'stones',
  });
  assert.equal(bill.doctype, 'Purchase Invoice');
  assert.equal(erp.get('Purchase Invoice', bill.erpnext_name).bill_no, 'ACME-77');

  let { result } = await tool('query_upcoming', { days_ahead: 30, direction: 'payable' });
  assert.equal(result.rows[0].ref, bill.erpnext_name);

  // An incoming payment can't settle a bill.
  ({ result } = await tool('save_transaction', {}, {
    transaction_type: 'payment', direction: 'income', amount: 12000, currency: 'THB', transaction_date: TODAY,
    parent_invoice_name: bill.erpnext_name, payment_account_id: ids.bbl,
  }));
  assert.match(result.error, /can't settle it/);

  await confirmAndSave({
    transaction_type: 'payment', direction: 'expense', amount: 12000, currency: 'THB', transaction_date: TODAY,
    parent_invoice_name: bill.erpnext_name, payment_account_id: ids.bbl, counterparty_name: 'Acme Supplies',
  });
  assert.equal(erp.get('Purchase Invoice', bill.erpnext_name).outstanding_amount, 0);
  assert.equal(walletBalance('BBL Savings'), 58200 - 12000);
});

test('advance given and returned nets the counterparty balance to zero', async () => {
  await confirmAndSave({
    transaction_type: 'advance_given', direction: 'expense', amount: 3000, currency: 'THB',
    transaction_date: TODAY, counterparty_name: 'Jackie', payment_account_id: ids.cash,
  });
  let { result } = await tool('query_balance_with_counterparty', { counterparty_search: 'Jackie' });
  assert.deepEqual(result.owes_you, { THB: 3000 });
  assert.deepEqual(result.you_owe, {});
  ids.jackie = result.counterparty.id;

  await confirmAndSave({
    transaction_type: 'payment', direction: 'income', amount: 3000, currency: 'THB',
    transaction_date: TODAY, counterparty_id: ids.jackie, payment_account_id: ids.cash,
  });
  ({ result } = await tool('query_balance_with_counterparty', { counterparty_id: ids.jackie }));
  assert.deepEqual(result.owes_you, {});
  assert.equal(walletBalance('1110 - Cash'), 4150);
});

test('foreign-currency advance received posts a balanced multi-currency JE', async () => {
  const r = await confirmAndSave({
    transaction_type: 'advance_received', direction: 'income', amount: 10000, currency: 'USD', exchange_rate: 32,
    transaction_date: TODAY, counterparty_name: 'Mike', payment_account_id: ids.dbs,
  });
  assert.equal(erp.get('Journal Entry', r.erpnext_name).multi_currency, 1);
  const { result } = await tool('query_balance_with_counterparty', { counterparty_search: 'Mike' });
  assert.deepEqual(result.you_owe, { USD: 10000 });
});

test('a contact who is both customer and supplier shows both sides', async () => {
  await confirmAndSave({
    transaction_type: 'bill_received', direction: 'expense', amount: 500, currency: 'USD', exchange_rate: 32,
    transaction_date: TODAY, category_code: '5900', counterparty_id: ids.jameel,
  });
  const { result } = await tool('query_balance_with_counterparty', { counterparty_id: ids.jameel });
  assert.deepEqual(result.owes_you, { USD: 600 });
  assert.deepEqual(result.you_owe, { USD: 500 });
  assert.equal(result.open_invoices, 1);
  assert.equal(result.open_bills, 1);
});

test('transaction summary by category and month', async () => {
  let { result } = await tool('query_transaction_summary', { direction: 'expense', group_by: 'category' });
  const byCat = Object.fromEntries(result.groups.map((g) => [g.key, g.total]));
  assert.deepEqual(byCat, {
    'Cost of Goods Sold': 12000, 'Miscellaneous Expenses': 16000, 'Travel Expenses': 1200, 'Entertainment Expenses': 850,
  });
  assert.equal(result.total, 30050);

  ({ result } = await tool('query_transaction_summary', { direction: 'income', counterparty_id: ids.jameel }));
  assert.equal(result.total, 1462500 + 32500);
});

test('cash/bank balance lists every wallet with live balances', async () => {
  const { result } = await tool('query_cash_bank_balance');
  const bal = Object.fromEntries(result.accounts.map((a) => [a.name, a.balance]));
  assert.deepEqual(bal, { AmEx: -1200, 'BBL Savings': 46200, Cash: 4150, 'DBS USD': 55000 });
  assert.deepEqual(result.totals_by_currency, { THB: 49150, USD: 55000 });
});

test('create_contact dedupes by name and later invoices link to it', async () => {
  let { result } = await tool('create_contact', { name: 'Tall Mike', nickname: 'tall mike', phone: '+66222' });
  assert.equal(result.existed, false);
  ({ result } = await tool('create_contact', { name: 'tall mike' }));
  assert.equal(result.existed, true);
  const id = result.contact.id;

  // Known contact → no phone ask on the invoice.
  await confirmAndSave({
    transaction_type: 'invoice_issued', direction: 'income', amount: 100000, currency: 'THB',
    transaction_date: TODAY, category_code: '4000', counterparty_id: id, payment_terms: 'net_30',
  });
  assert.equal(erp.get('Customer', 'Tall Mike').mobile_no, '+66222');
});
