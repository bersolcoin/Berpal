/**
 * Thai VAT / WHT, multi-item invoices and stock Items, end-to-end through the same tool entry
 * point the LLM uses, against test/fake-erpnext.js + pg-mem. Steps share state and run in order.
 *
 * Expected figures are worked out by hand in the comments (Frappe flt: exact halves round UP),
 * never by calling the code under test.
 */
process.env.ERPNEXT_URL = 'http://erp.test';
delete process.env.OPENAI_API_KEY;

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { FakeErpNext, COMPANY, TODAY } = require('./fake-erpnext');
const db = require('../src/db');
const { executeTool } = require('../src/tools');
const { computeTotals, resolveTaxAccount } = require('../src/erp-sync/taxes');
const { normalizeItemCode, minQtyFrom } = require('../src/erp-sync/items');

const erp = new FakeErpNext();
let user;
const ids = {};

async function tool(name, args = {}, draft = {}) {
  const walletOptions = Object.values(ids).filter(Number.isInteger);
  const ctx = { user, draft: { wallet_options: walletOptions, confirmation_pending: true, ...draft }, saved: null, cancelled: false, confirmationRequested: false };
  const result = await executeTool(name, args, ctx);
  return { result, ctx };
}

async function confirmAndSave(draft) {
  const confirm = await tool('request_confirmation', {}, draft);
  assert.equal(confirm.result.ok, true, `request_confirmation: ${confirm.result.error}`);
  // Next turn: handle() has stored the signature of the card the user saw in confirmation_pending.
  const { result } = await tool('save_transaction', {}, { ...confirm.ctx.draft, confirmation_pending: confirm.ctx.draft.confirmation_sig });
  assert.equal(result.ok, true, `save_transaction: ${result.error}`);
  return { ...result, confirm: confirm.result };
}

/** Net Dr − Cr (company currency) per account for one voucher. */
function gl(voucherNo) {
  const out = {};
  for (const g of erp.all('GL Entry').filter((x) => x.voucher_no === voucherNo)) {
    out[g.account] = Math.round(((out[g.account] || 0) + g.debit - g.credit) * 100) / 100;
  }
  return out;
}

function bin(code) {
  return erp.get('Bin', `${code}-TC|Stores - TC`);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const sale = (extra) => ({
  transaction_type: 'invoice_issued', direction: 'income', currency: 'THB', transaction_date: TODAY,
  category_code: '4000', counterparty_name: 'Siam Jewels', counterparty_contact_skipped: true, payment_terms: 'net_30',
  ...extra,
});
const bill = (extra) => ({
  transaction_type: 'bill_received', direction: 'expense', currency: 'THB', transaction_date: TODAY,
  category_code: '5700', counterparty_name: 'Krungthep Consulting Co., Ltd.', counterparty_contact_skipped: true,
  payment_terms: 'net_30', ...extra,
});

async function setRegistered(v) {
  const { result } = await tool('set_tax_settings', { vat_registered: v });
  assert.equal(result.ok, true);
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
     VALUES ('+66001', $1, 'k', 's', 'THB', 'THB', 'TH', $2, $2) RETURNING *`,
    [COMPANY, now]
  );
  user = r.rows[0];
  // Decoy: a LIKE '%Input VAT%' lookup would grab this (Thai service VAT not yet due).
  erp.create('Account', { company: COMPANY, account_name: 'Undue Input VAT', parent_account: '2300 - Duties and Taxes - TC', account_type: 'Tax' });
  const { result } = await tool('list_user_accounts');
  ids.cash = result.accounts[0].id;
  ids.bbl = (await tool('create_user_account', { name: 'BBL Current', parent_code: '1100', currency: 'THB' })).result.wallet.id;
  ids.usd = (await tool('create_user_account', { name: 'KBank USD', parent_code: '1100', currency: 'USD' })).result.wallet.id;
});

test('Frappe rounding: exact half-satang rounds up', () => {
  // 30.50 × 7% = 2.135 → 2.14; gross 32.64
  assert.deepEqual(computeTotals({ amount: 30.5, tax_rate: 7, tax_inclusive: false }), {
    net: 30.5, vat: 2.14, gross: 32.64, wht: 0, due: 32.64,
    lines: [{ description: null, qty: 1, rate: 30.5, item_code: null, net: 30.5, gross: 32.64 }],
  });
  // 1.50 × 7% = 0.105 → 0.11
  assert.equal(computeTotals({ amount: 1.5, tax_rate: 7, tax_inclusive: false }).vat, 0.11);
  // 1,234.50 × 3% = 37.035 → 37.04; due 1,197.46
  const w = computeTotals({ amount: 1234.5, wht_rate: 3 });
  assert.deepEqual([w.wht, w.due], [37.04, 1197.46]);
  // 4,850.50 × 3% = 145.515 → 145.52
  assert.equal(computeTotals({ amount: 4850.5, wht_rate: 3 }).wht, 145.52);
});

test('VAT needs the user\'s own registration status; set_tax_settings records it', async () => {
  let { result } = await tool('request_confirmation', {}, sale({ amount: 100, tax_rate: 7, tax_inclusive: false }));
  assert.match(result.error, /Are you VAT-registered/);
  ({ result } = await tool('set_tax_settings', { vat_registered: true, tax_id: '0105-55501-234-5' }));
  assert.deepEqual(result, { ok: true, vat_registered: true, tax_id: '0105555012345' });
  const row = (await db.query('SELECT vat_registered, tax_id FROM users WHERE id = $1', [user.id])).rows[0];
  assert.deepEqual(row, { vat_registered: 1, tax_id: '0105555012345' });
});

test('VAT exclusive sales invoice: Debtors gross, Sales net, Output VAT under Duties and Taxes', async () => {
  const r = await confirmAndSave(sale({ amount: 10000, tax_rate: 7, tax_inclusive: false, description: 'sapphire' }));
  assert.deepEqual(r.confirm.totals, { currency: 'THB', net: 10000, vat: 700, gross: 10700, vat_rate: 7, vat_claimable: true });
  assert.equal(r.confirm.base_amount, 10700);
  const inv = erp.get('Sales Invoice', r.erpnext_name);
  assert.deepEqual(inv.taxes.map((t) => [t.charge_type, t.description, t.tax_amount]), [['Actual', 'VAT 7%', 700]]);
  assert.equal(inv.disable_rounded_total, 1);
  assert.equal(inv.outstanding_amount, 10700);
  assert.equal(erp.get('Account', 'Output VAT - TC').parent_account, '2300 - Duties and Taxes - TC');
  assert.deepEqual(gl(r.erpnext_name), { '1310 - Debtors - TC': 10700, '4110 - Sales - TC': -10000, 'Output VAT - TC': -700 });
});

test('half-satang VAT posts the same figure as the card (30.50 + 2.14)', async () => {
  const r = await confirmAndSave(sale({ amount: 30.5, tax_rate: 7, tax_inclusive: false }));
  assert.equal(r.confirm.totals.vat, 2.14);
  assert.deepEqual(gl(r.erpnext_name), { '1310 - Debtors - TC': 32.64, '4110 - Sales - TC': -30.5, 'Output VAT - TC': -2.14 });
});

test('VAT inclusive: net item rate + Actual VAT, so 119 posts 111.21 + 7.79 (not 7.78 + Round Off)', async () => {
  // 119 / 1.07 = 111.2149… → 111.21; VAT = 119 − 111.21 = 7.79
  const r = await confirmAndSave(sale({ amount: 119, tax_rate: 7, tax_inclusive: true }));
  assert.deepEqual([r.confirm.totals.net, r.confirm.totals.vat, r.confirm.totals.gross], [111.21, 7.79, 119]);
  const inv = erp.get('Sales Invoice', r.erpnext_name);
  assert.equal(inv.items[0].rate, 111.21);
  assert.equal(inv.outstanding_amount, 119);
  assert.deepEqual(gl(r.erpnext_name), { '1310 - Debtors - TC': 119, '4110 - Sales - TC': -111.21, 'Output VAT - TC': -7.79 });
});

test('fake mirrors current ERPNext for an inclusive On Net Total row: 7.78 VAT, 0.01 to Round Off', () => {
  // flt(119/1.07) = 111.21; flt(0.07 × 111.21 = 7.7847) = 7.78; 119 − 111.21 − 7.78 = 0.01
  const inv = erp.create('Sales Invoice', {
    company: COMPANY, customer: 'Siam Jewels', currency: 'THB', docstatus: 1, disable_rounded_total: 1,
    items: [{ item_code: 'GEN-SALE', qty: 1, rate: 119, income_account: '4110 - Sales - TC' }],
    taxes: [{ charge_type: 'On Net Total', rate: 7, account_head: 'Output VAT - TC', included_in_print_rate: 1 }],
  });
  assert.deepEqual([inv.net_total, inv.taxes[0].tax_amount, inv.grand_total_diff, inv.grand_total], [111.21, 7.78, 0.01, 119]);
  assert.deepEqual(gl(inv.name), {
    '1310 - Debtors - TC': 119, '4110 - Sales - TC': -111.21, 'Output VAT - TC': -7.78, '5225 - Round Off - TC': -0.01,
  });
});

test('two-row inclusive invoice: per-row net rates, VAT is the remainder', async () => {
  // row 1: 1,070 / 1.07 = 1,000.00 × 2 = 2,000.00; row 2: 500 / 1.07 = 467.2897… → 467.29
  // net 2,467.29; gross 2×1,070 + 500 = 2,640.00; VAT 172.71
  const r = await confirmAndSave(sale({
    tax_rate: 7, tax_inclusive: true,
    items: [{ description: 'ruby pair', qty: 2, rate: 1070 }, { description: 'setting', qty: 1, rate: 500 }],
  }));
  assert.equal(r.confirm.draft.amount, 2640);
  assert.deepEqual([r.confirm.totals.net, r.confirm.totals.vat, r.confirm.totals.gross], [2467.29, 172.71, 2640]);
  const inv = erp.get('Sales Invoice', r.erpnext_name);
  assert.deepEqual(inv.items.map((i) => [i.qty, i.rate]), [[2, 1000], [1, 467.29]]);
  assert.equal(inv.grand_total, 2640);
  assert.deepEqual(gl(r.erpnext_name), { '1310 - Debtors - TC': 2640, '4110 - Sales - TC': -2467.29, 'Output VAT - TC': -172.71 });
});

test('inclusive VAT with qty > 1 is computed on the line total, not per unit', async () => {
  // 100 × 1.00 = 100.00 gross; VAT = flt(100 × 7/107 = 6.542…) = 6.54 (per-unit back-out would give 7.00)
  // net 93.46 doesn't divide by 100 → posted as one row "100 × pearl bead" at 93.46
  let r = await confirmAndSave(sale({ tax_rate: 7, tax_inclusive: true, items: [{ description: 'pearl bead', qty: 100, rate: 1 }] }));
  assert.deepEqual([r.confirm.totals.net, r.confirm.totals.vat, r.confirm.totals.gross], [93.46, 6.54, 100]);
  let inv = erp.get('Sales Invoice', r.erpnext_name);
  assert.deepEqual(inv.items.map((i) => [i.qty, i.rate, i.description]), [[1, 93.46, '100 × pearl bead']]);
  assert.deepEqual(gl(r.erpnext_name), { '1310 - Debtors - TC': 100, '4110 - Sales - TC': -93.46, 'Output VAT - TC': -6.54 });

  // 50 × 33.33 = 1,666.50; VAT = flt(11,665.5 / 107 = 109.0233…) = 109.02; net 1,557.48
  r = await confirmAndSave(sale({ tax_rate: 7, tax_inclusive: true, items: [{ description: 'polishing', qty: 50, rate: 33.33 }] }));
  assert.deepEqual([r.confirm.totals.net, r.confirm.totals.vat, r.confirm.totals.gross], [1557.48, 109.02, 1666.5]);
  inv = erp.get('Sales Invoice', r.erpnext_name);
  assert.deepEqual(inv.items.map((i) => [i.qty, i.rate]), [[1, 1557.48]]);
  assert.equal(inv.grand_total, 1666.5);
});

test('tax_inclusive required; tax_amount without a rate refused; VAT on a payment refused', async () => {
  let { result } = await tool('request_confirmation', {}, sale({ amount: 100, tax_rate: 7 }));
  assert.match(result.error, /tax_inclusive/);
  ({ result } = await tool('request_confirmation', {}, sale({ amount: 100, tax_amount: 7 })));
  assert.match(result.error, /tax_rate/);
  ({ result } = await tool('request_confirmation', {}, {
    transaction_type: 'payment', direction: 'income', amount: 100, currency: 'THB', transaction_date: TODAY,
    counterparty_name: 'Siam Jewels', payment_account_id: ids.cash, tax_rate: 7, tax_inclusive: true,
  }));
  assert.match(result.error, /not on a payment/);
});

test('VAT purchase bill debits Input VAT, an ASSET under Tax Assets (not the "Undue Input VAT" decoy)', async () => {
  const r = await confirmAndSave(bill({ amount: 2140, tax_rate: 7, tax_inclusive: true, category_code: '5900', counterparty_name: 'OfficeMate' }));
  assert.deepEqual([r.confirm.totals.net, r.confirm.totals.vat, r.confirm.totals.gross], [2000, 140, 2140]);
  const vat = erp.get('Account', 'Input VAT - TC');
  assert.equal(vat.parent_account, '1500 - Tax Assets - TC');
  assert.equal(vat.root_type, 'Asset');
  assert.deepEqual(gl(r.erpnext_name), { '2110 - Creditors - TC': -2140, '5223 - Miscellaneous Expenses - TC': 2000, 'Input VAT - TC': 140 });
});

test('resolveTaxAccount refuses a same-named GROUP', async () => {
  const stub = { company: 'Other Co', listResource: async () => ({ data: [{ name: 'Output VAT - OC', is_group: 1 }] }) };
  await assert.rejects(resolveTaxAccount(stub, 'output_vat'), /is a group account/);
});

test('abbreviated tax invoice (vat_claimable=false): VAT is a cost, no Input VAT', async () => {
  // 1,000 + 7% = 1,070 all to expense
  const r = await confirmAndSave(bill({ amount: 1000, tax_rate: 7, tax_inclusive: false, vat_claimable: false, category_code: '5900', counterparty_name: 'Café Amazon' }));
  assert.equal(r.confirm.totals.vat_claimable, false);
  assert.deepEqual(gl(r.erpnext_name), { '2110 - Creditors - TC': -1070, '5223 - Miscellaneous Expenses - TC': 1070 });
  const inv = erp.get('Purchase Invoice', r.erpnext_name);
  assert.equal(inv.taxes.length, 0);
  assert.deepEqual(inv.items.map((i) => [i.qty, i.rate]), [[1, 1070]], 'one row at gross, no separate VAT row');
});

test('non-claimable VAT on a service bill with WHT: row at gross, WHT still on the pre-VAT net', async () => {
  // net 10,000; VAT 700 (not claimable) → row 10,700; WHT 3% × 10,000 = 300; owed 10,400
  const r = await confirmAndSave(bill({ amount: 10000, tax_rate: 7, tax_inclusive: false, vat_claimable: false, wht_rate: 3, wht_form: 'PND53', counterparty_name: 'Small Repair Shop' }));
  const inv = erp.get('Purchase Invoice', r.erpnext_name);
  assert.deepEqual(inv.items.map((i) => [i.qty, i.rate]), [[1, 10700]]);
  assert.deepEqual(inv.taxes.map((t) => [t.description, t.tax_amount]), [['WHT 3% (PND53)', 300]]);
  assert.equal(inv.outstanding_amount, 10400);
  assert.deepEqual(gl(r.erpnext_name), { '2110 - Creditors - TC': -10400, '5206 - Legal Expenses - TC': 10700, 'WHT Payable - TC': -300 });
});

test('not VAT-registered: sales VAT refused; purchase VAT goes to expense', async () => {
  await setRegistered(false);
  try {
    let { result } = await tool('request_confirmation', {}, sale({ amount: 1000, tax_rate: 7, tax_inclusive: false }));
    assert.match(result.error, /not VAT-registered/);
    ({ result } = await tool('request_confirmation', {}, {
      transaction_type: 'cash', direction: 'income', amount: 1000, currency: 'THB', transaction_date: TODAY,
      category_code: '4000', payment_account_id: ids.cash, tax_rate: 7, tax_inclusive: true,
    }));
    assert.match(result.error, /not VAT-registered/);

    // cash expense 535 incl VAT, unregistered → expense 535, no VAT line
    const r = await confirmAndSave({
      transaction_type: 'cash', direction: 'expense', amount: 535, currency: 'THB', transaction_date: TODAY,
      category_code: '5900', payment_account_id: ids.cash, tax_rate: 7, tax_inclusive: true,
    });
    assert.deepEqual(gl(r.erpnext_name), { '5223 - Miscellaneous Expenses - TC': 535, '1110 - Cash - TC': -535 });
  } finally {
    await setRegistered(true);
  }
});

test('WHT bill: outstanding = gross − WHT; the card refuses paying the gross, the net settles it', async () => {
  let { result } = await tool('request_confirmation', {}, bill({ amount: 10000, tax_rate: 7, tax_inclusive: false, wht_rate: 3 }));
  assert.match(result.error, /wht_form/);

  // net 10,000; VAT 700; gross 10,700; WHT 3% of net = 300; supplier owed 10,400
  const r = await confirmAndSave(bill({ amount: 10000, tax_rate: 7, tax_inclusive: false, wht_rate: 3, wht_form: 'PND53' }));
  assert.deepEqual(r.confirm.totals, {
    currency: 'THB', net: 10000, vat: 700, gross: 10700, vat_rate: 7, vat_claimable: true,
    wht: 300, wht_rate: 3, wht_form: 'PND53', payable_to_counterparty: 10400,
  });
  const inv = erp.get('Purchase Invoice', r.erpnext_name);
  assert.equal(inv.outstanding_amount, 10400);
  assert.deepEqual(inv.taxes.map((t) => [t.description, t.add_deduct_tax, t.tax_amount]), [['VAT 7%', 'Add', 700], ['WHT 3% (PND53)', 'Deduct', 300]]);
  assert.deepEqual(gl(r.erpnext_name), {
    '2110 - Creditors - TC': -10400, '5206 - Legal Expenses - TC': 10000, 'Input VAT - TC': 700, 'WHT Payable - TC': -300,
  });
  assert.equal(erp.get('Account', 'WHT Payable - TC').parent_account, '2300 - Duties and Taxes - TC');

  const pay = {
    transaction_type: 'payment', direction: 'expense', currency: 'THB', transaction_date: TODAY,
    parent_invoice_name: r.erpnext_name, parent_invoice_doctype: 'Purchase Invoice', payment_account_id: ids.bbl,
  };
  ({ result } = await tool('request_confirmation', {}, { ...pay, amount: 10700 }));
  assert.equal(result.ok, false);
  assert.match(result.error, /300 THB withholding tax deducted.*owed 10400/);

  const whtBefore = erp.balanceOn('WHT Payable - TC', TODAY);
  await confirmAndSave({ ...pay, amount: 10400 });
  assert.equal(erp.get('Purchase Invoice', r.erpnext_name).outstanding_amount, 0);
  assert.equal(erp.balanceOn('BBL Current - TC', TODAY), -10400);
  assert.equal(erp.balanceOn('WHT Payable - TC', TODAY), whtBefore, 'paying the supplier leaves the WHT owed to the Revenue Department');
});

test('half-satang WHT: 1,234.50 × 3% posts 37.04, supplier owed 1,197.46', async () => {
  const r = await confirmAndSave(bill({ amount: 1234.5, wht_rate: 3, wht_form: 'PND3', counterparty_name: 'Somchai' }));
  assert.equal(erp.get('Purchase Invoice', r.erpnext_name).outstanding_amount, 1197.46);
  assert.equal(gl(r.erpnext_name)['WHT Payable - TC'], -37.04);
});

test('"transferred 9,700 after 3%": paid_after_wht is grossed up', async () => {
  // 9,700 / 0.97 = 10,000
  let r = await confirmAndSave({
    transaction_type: 'cash', direction: 'expense', currency: 'THB', transaction_date: TODAY, category_code: '5700',
    payment_account_id: ids.bbl, paid_after_wht: 9700, wht_rate: 3, wht_form: 'PND3',
  });
  assert.equal(r.confirm.draft.amount, 10000);
  assert.deepEqual(gl(r.erpnext_name), { '5206 - Legal Expenses - TC': 10000, 'BBL Current - TC': -9700, 'WHT Payable - TC': -300 });
  // with VAT on top: 10,400 / (1 + 0.07 − 0.03) = 10,000 net
  r = await confirmAndSave(bill({ paid_after_wht: 10400, tax_rate: 7, tax_inclusive: false, wht_rate: 3, wht_form: 'PND53' }));
  assert.equal(r.confirm.draft.amount, 10000);
  assert.equal(r.confirm.totals.payable_to_counterparty, 10400);
});

test('paid_after_wht is re-derived when the rate changes, and an unreachable figure is explained', async () => {
  const draft = bill({ paid_after_wht: 9700, wht_rate: 3, wht_form: 'PND3', counterparty_name: 'Somchai' });
  let { result } = await tool('request_confirmation', {}, draft);
  assert.equal(result.draft.amount, 10000); // 9,700 / 0.97
  // rate corrected to 5%: 9,700 / 0.95 = 10,210.526… → 10,210.53 (WHT 510.5265 → 510.53; 10,210.53 − 510.53 = 9,700)
  ({ result } = await tool('request_confirmation', {}, { ...draft, amount: 10000, wht_rate: 5 }));
  assert.equal(result.draft.amount, 10210.53);
  assert.equal(result.totals.payable_to_counterparty, 9700);

  // +7% VAT −3% WHT: net 9,615.64 → VAT 673.09, WHT 288.47, due 10,000.26; net 9,615.65 → 673.10,
  // 288.47, due 10,000.28. Nothing leaves exactly 10,000.27.
  ({ result } = await tool('request_confirmation', {}, bill({ paid_after_wht: 10000.27, tax_rate: 7, tax_inclusive: false, wht_rate: 3, wht_form: 'PND53' })));
  assert.equal(result.ok, false);
  assert.match(result.error, /nearest is 10000\.26 paid \(difference -0\.01\) for an amount of 9615\.64/);
});

test('a newly stated amount clears a stale paid_after_wht', async () => {
  const stale = bill({ paid_after_wht: 9700, wht_rate: 5, wht_form: 'PND3', counterparty_name: 'Somchai' });
  const { result } = await tool('update_draft', { amount: 12000 }, stale);
  assert.equal(result.current_draft.paid_after_wht, undefined);
  const { result: card } = await tool('request_confirmation', {}, result.current_draft);
  assert.equal(card.draft.amount, 12000); // not re-derived to 10,210.53
  assert.equal(card.totals.wht, 600); // 5% × 12,000
});

test('lines too small to post are refused', async () => {
  // 2.34 + 0.81 + 0.01 incl VAT: G 3.16, VAT flt(22.12/107 = 0.2067) = 0.21, net 2.95;
  // line nets 2.19 (2.34/1.07) and 0.76 (0.81/1.07) leave 0.00 for the third line.
  let { result } = await tool('request_confirmation', {}, sale({ tax_rate: 7, tax_inclusive: true,
    items: [{ description: 'a', rate: 2.34 }, { description: 'b', rate: 0.81 }, { description: 'c', rate: 0.01 }] }));
  assert.match(result.error, /line 3 \(c\) is too small to post/);
  // 29 × 0.01 incl VAT stock line: G 0.29, VAT flt(2.03/107 = 0.0190) = 0.02, net 0.27 → 27 satang / 29 units = 0 rate
  ({ result } = await tool('request_confirmation', {}, bill({ category_code: '5000', tax_rate: 7, tax_inclusive: true,
    items: [{ item_code: 'TINY-1', description: 'chips', qty: 29, rate: 0.01 }] })));
  assert.match(result.error, /line 1 \(chips\) is too small to post/);
});

test('WHT rules: Thai rates only, expenses only, 0 clears it', async () => {
  let { result } = await tool('request_confirmation', {}, bill({ amount: 1000, wht_rate: 7, wht_form: 'PND53' }));
  assert.match(result.error, /not a Thai WHT rate/);
  ({ result } = await tool('request_confirmation', {}, sale({ amount: 1000, wht_rate: 3, wht_form: 'PND53' })));
  assert.match(result.error, /only applies/);
  const r = await confirmAndSave(bill({ amount: 1000, wht_rate: 0, counterparty_name: 'Cleared Co' }));
  assert.equal(r.confirm.totals, undefined);
  assert.equal(erp.get('Purchase Invoice', r.erpnext_name).outstanding_amount, 1000);
});

test('cash expense with VAT and WHT: wallet moves by gross − WHT', async () => {
  // net 5,000; VAT 350; WHT 5% = 250; wallet 5,100
  const r = await confirmAndSave({
    transaction_type: 'cash', direction: 'expense', amount: 5000, currency: 'THB', transaction_date: TODAY,
    category_code: '5400', payment_account_id: ids.bbl, tax_rate: 7, tax_inclusive: false, wht_rate: 5, wht_form: 'PND3', description: 'shop rent',
  });
  assert.deepEqual(gl(r.erpnext_name), {
    '5209 - Office Rent - TC': 5000, 'Input VAT - TC': 350, 'WHT Payable - TC': -250, 'BBL Current - TC': -5100,
  });
});

test('foreign-currency cash expense with VAT balances in THB for 200 amounts', async () => {
  // e.g. 100.01 USD incl VAT @ 36.4123: wallet Cr flt(100.01 × 36.4123 = 3641.594…) = 3641.59;
  // net 93.47 → 3403.46, VAT 6.54 → 238.14: 3641.60 ≠ 3641.59 unless one THB line absorbs it.
  let adjusted = 0;
  for (let i = 0; i < 200; i++) {
    const amount = Math.round((100.01 + i * 0.37) * 100) / 100;
    const r = await confirmAndSave({
      transaction_type: 'cash', direction: 'expense', amount, currency: 'USD', exchange_rate: 36.4123, transaction_date: TODAY,
      category_code: '5900', payment_account_id: ids.usd, tax_rate: 7, tax_inclusive: true,
    });
    const lines = gl(r.erpnext_name);
    assert.equal(Math.abs(Math.round(Object.values(lines).reduce((s, v) => s + v, 0) * 100)), 0);
    const walletBase = Math.round(Number((amount * 36.4123 * 100).toFixed(8))) / 100;
    assert.equal(lines['KBank USD - TC'], -walletBase, `wallet base for ${amount}`);
    const netUsd = Math.round(Number((amount / 1.07 * 100).toFixed(8))) / 100;
    if (lines['5223 - Miscellaneous Expenses - TC'] !== Math.round(Number((netUsd * 36.4123 * 100).toFixed(8))) / 100) adjusted++;
    if (i === 0) {
      assert.deepEqual(lines, { 'KBank USD - TC': -3641.59, '5223 - Miscellaneous Expenses - TC': 3403.45, 'Input VAT - TC': 238.14 });
    }
  }
  assert.ok(adjusted > 0, 'the scan must include amounts that needed balancing');
});

test('fake ERPNext rejects a VAT row whose account_head is not a tax account', async () => {
  await assert.rejects(
    async () => erp.create('Sales Invoice', {
      company: COMPANY, customer: 'Siam Jewels', currency: 'THB', docstatus: 1,
      items: [{ item_code: 'GEN-SALE', qty: 1, rate: 100, income_account: '4110 - Sales - TC' }],
      taxes: [{ charge_type: 'Actual', tax_amount: 7, account_head: '1310 - Debtors - TC', description: 'VAT 7%' }],
    }),
    /must be of type Tax/
  );
  await assert.rejects(
    async () => erp.create('Sales Invoice', {
      company: COMPANY, customer: 'Siam Jewels', currency: 'THB', docstatus: 1,
      items: [{ item_code: 'GEN-SALE', qty: 1, rate: 100, income_account: '4110 - Sales - TC' }],
      taxes: [{ charge_type: 'On Net Total', rate: 7, account_head: '2300 - Duties and Taxes - TC' }],
    }),
    /group account/
  );
});

test('multi-item: mismatch, >2-dp rates and fractional qty refused; omitted amount computed', async () => {
  const items = [{ description: 'ruby cabochon', qty: 2, rate: 1500 }, { description: 'setting labour', qty: 1, rate: 800 }];
  let { result } = await tool('request_confirmation', {}, sale({ items, amount: 3500 }));
  assert.match(result.error, /does not match the items.*3800/);
  ({ result } = await tool('request_confirmation', {}, sale({ items: [{ description: 'x', rate: 0 }] })));
  assert.match(result.error, /positive rate/);
  ({ result } = await tool('request_confirmation', {}, sale({ items: [{ description: 'thirds', qty: 3, rate: 33.333 }] })));
  assert.match(result.error, /more than 2 decimals/);
  ({ result } = await tool('request_confirmation', {}, sale({ items: [{ description: 'ruby 2.5ct', qty: 2.5, rate: 1000 }] })));
  assert.match(result.error, /whole number/);
  assert.throws(() => erp.create('Sales Invoice', {
    company: COMPANY, customer: 'Siam Jewels', currency: 'THB', docstatus: 1,
    items: [{ item_code: 'GEN-SALE', qty: 2.5, rate: 10, income_account: '4110 - Sales - TC' }],
  }), /cannot be a fraction/);

  // 2 × 1,500 + 800 = 3,800; VAT 266; gross 4,066
  const r = await confirmAndSave(sale({ items, tax_rate: 7, tax_inclusive: false }));
  assert.equal(r.confirm.draft.amount, 3800);
  assert.deepEqual([r.confirm.totals.net, r.confirm.totals.vat, r.confirm.totals.gross], [3800, 266, 4066]);
  const inv = erp.get('Sales Invoice', r.erpnext_name);
  assert.deepEqual(inv.items.map((i) => [i.item_code, i.qty, i.rate, i.description]),
    [['GEN-SALE', 2, 1500, 'ruby cabochon'], ['GEN-SALE', 1, 800, 'setting labour']]);
  assert.equal(inv.update_stock, undefined, 'untracked lines never move stock');
});

test('single-amount drafts post as before (one generic row, no taxes)', async () => {
  const r = await confirmAndSave(sale({ amount: 900 }));
  const inv = erp.get('Sales Invoice', r.erpnext_name);
  assert.deepEqual(inv.items.map((i) => [i.item_code, i.qty, i.rate]), [['GEN-SALE', 1, 900]]);
  assert.deepEqual(inv.taxes, []);
  assert.equal(r.confirm.totals, undefined);
});

test('stock lifecycle: buy pa2293 → Bin 1 at ex-VAT cost; sell as "PA-2293" → 0 with COGS; resell refused', async () => {
  // 21,400 incl VAT → 20,000 net, 1,400 Input VAT (recoverable, so not part of the stone's cost)
  const buy = await confirmAndSave(bill({
    category_code: '5000', counterparty_name: 'Chanthaburi Gems', payment_terms: 'net_0',
    items: [{ item_code: 'pa2293', description: 'ruby 7.68ct', qty: 1, rate: 21400 }], tax_rate: 7, tax_inclusive: true,
  }));
  const pinv = erp.get('Purchase Invoice', buy.erpnext_name);
  assert.equal(pinv.update_stock, 1);
  assert.deepEqual([pinv.items[0].item_code, pinv.items[0].rate, pinv.items[0].warehouse], ['PA2293-TC', 20000, 'Stores - TC']);
  const item = erp.get('Item', 'PA2293-TC');
  assert.deepEqual([item.is_stock_item, item.item_group, item.stock_uom], [1, 'Products', 'Nos']);
  assert.deepEqual([bin('PA2293').actual_qty, bin('PA2293').valuation_rate], [1, 20000]);
  assert.deepEqual(gl(buy.erpnext_name), { '2110 - Creditors - TC': -21400, '1410 - Stock In Hand - TC': 20000, 'Input VAT - TC': 1400 });

  const sell = await confirmAndSave(sale({ items: [{ item_code: 'PA-2293', description: 'ruby 7.68ct', rate: 45000 }] }));
  assert.equal(bin('PA2293').actual_qty, 0);
  assert.deepEqual(gl(sell.erpnext_name), {
    '1310 - Debtors - TC': 45000, '4110 - Sales - TC': -45000,
    '5111 - Cost of Goods Sold - TC': 20000, '1410 - Stock In Hand - TC': -20000,
  });
  const { rows } = await db.query('SELECT item_code, erpnext_name FROM item_cache WHERE user_id = $1', [user.id]);
  assert.deepEqual(rows, [{ item_code: 'PA2293', erpnext_name: 'PA2293-TC' }], 'pa2293 and PA-2293 are one item');

  const again = sale({ items: [{ item_code: 'pa 2293', rate: 45000 }] });
  const { result } = await tool('request_confirmation', {}, again);
  assert.match(result.error, /PA2293 is not in stock \(0 available/);
  const { result: saved } = await tool('save_transaction', {}, again);
  assert.equal(saved.ok, false, 'save re-checks stock too');
});

test('stock qty > 1 whose net does not divide keeps the qty and books the leftover satang', async () => {
  // 2 × 1,001 = 2,002 incl VAT; VAT = flt(14,014 / 107 = 130.971…) = 130.97; net 1,871.03
  // 1,871.03 / 2 = 935.515 → 935.51 × 2 = 1,871.02 on the stock row + 0.01 rounding row
  const r = await confirmAndSave(bill({
    category_code: '5000', counterparty_name: 'Chanthaburi Gems', payment_terms: 'net_0', tax_rate: 7, tax_inclusive: true,
    items: [{ item_code: 'TW-2', description: 'tourmaline pair', qty: 2, rate: 1001 }],
  }));
  const inv = erp.get('Purchase Invoice', r.erpnext_name);
  assert.deepEqual(inv.items.map((i) => [i.item_code, i.qty, i.rate]), [['TW2-TC', 2, 935.51], ['GEN-PURCHASE', 1, 0.01]]);
  assert.deepEqual([bin('TW2').actual_qty, bin('TW2').valuation_rate], [2, 935.51]);
  assert.deepEqual(gl(r.erpnext_name), {
    '2110 - Creditors - TC': -2002, '1410 - Stock In Hand - TC': 1871.02, '5111 - Cost of Goods Sold - TC': 0.01, 'Input VAT - TC': 130.97,
  });
});

test('non-claimable VAT on a stone is part of its cost (valued at gross)', async () => {
  // 10,000 + 7% on an abbreviated tax invoice → stone valued at 10,700
  await confirmAndSave(bill({
    category_code: '5000', counterparty_name: 'Market Stall', payment_terms: 'net_0', tax_rate: 7, tax_inclusive: false, vat_claimable: false,
    items: [{ item_code: 'NC-1', description: 'garnet', rate: 10000 }],
  }));
  assert.deepEqual([bin('NC1').actual_qty, bin('NC1').valuation_rate], [1, 10700]);
});

test('Thai stone ids stay distinct items', async () => {
  await confirmAndSave(bill({
    category_code: '5000', counterparty_name: 'Chanthaburi Gems', payment_terms: 'net_0',
    items: [{ item_code: 'ทับทิม01', description: 'ruby', rate: 1000 }, { item_code: 'ไพลิน 01', description: 'sapphire', rate: 2000 }],
  }));
  assert.deepEqual([bin('ทับทิม01').actual_qty, bin('ทับทิม01').valuation_rate], [1, 1000]);
  assert.deepEqual([bin('ไพลิน01').actual_qty, bin('ไพลิน01').valuation_rate], [1, 2000]);
  assert.equal(erp.get('Item', 'ไพลิน01-TC').item_name, 'ไพลิน 01 sapphire');
});

test('back-dated sale into a later dip is refused at the card, and ERPNext agrees', async () => {
  // DIP: bought day−10, sold day−5, bought again day−1. A sale dated day−7 has 1 on hand that
  // day, but would take day−5 to −1 → refused. Dated today (balance 1, nothing later) it's fine.
  const d = (n) => addDays(TODAY, -n);
  const stone = [{ item_code: 'DIP-1', description: 'peridot', rate: 1000 }];
  await confirmAndSave(bill({ transaction_date: d(10), category_code: '5000', counterparty_name: 'Chanthaburi Gems', payment_terms: 'net_0', items: stone }));
  await confirmAndSave(sale({ transaction_date: d(5), items: [{ ...stone[0], rate: 2000 }] }));
  await confirmAndSave(bill({ transaction_date: d(1), category_code: '5000', counterparty_name: 'Chanthaburi Gems', payment_terms: 'net_0', items: stone }));
  assert.equal(bin('DIP1').actual_qty, 1);

  const { result } = await tool('request_confirmation', {}, sale({ transaction_date: d(7), items: [{ ...stone[0], rate: 2000 }] }));
  assert.equal(result.ok, false);
  assert.match(result.error, /DIP1 is not in stock on .* \(0 available, selling 1\)/);
  assert.throws(() => erp.create('Sales Invoice', {
    company: COMPANY, customer: 'Siam Jewels', currency: 'THB', docstatus: 1, update_stock: 1, set_posting_time: 1, posting_date: d(7),
    items: [{ item_code: 'DIP1-TC', qty: 1, rate: 10, income_account: '4110 - Sales - TC', warehouse: 'Stores - TC' }],
  }), /NegativeStockError/);

  await confirmAndSave(sale({ items: [{ ...stone[0], rate: 2000 }] }));
  assert.equal(bin('DIP1').actual_qty, 0);
});

test('item codes: full-width forms fold (NFKC)', () => {
  assert.equal(normalizeItemCode('ｐａ２２９３'), 'PA2293');
  assert.equal(normalizeItemCode('ｐａ－２２９３'), 'PA2293');
});

test('minQtyFrom sequences same-day entries by posting time, then creation', async () => {
  const day = '2026-10-01';
  const sles = [ // deliberately unsorted
    { posting_date: day, posting_time: '11:00:00', creation: 'c3', actual_qty: 1 },
    { posting_date: day, posting_time: '09:00:00', creation: 'c1', actual_qty: 1 },
    { posting_date: day, posting_time: '10:00:00', creation: 'c2', actual_qty: -1 },
  ];
  const stub = { listResource: async () => ({ data: sles }) };
  // sale at 09:30: balance 1, then 10:00 → 0, 11:00 → 1; lowest 0
  assert.equal(await minQtyFrom(stub, 'X', 'W', day, '09:30:00'), 0);
  // sale at 12:00: all three are before it; balance 1, nothing later
  assert.equal(await minQtyFrom(stub, 'X', 'W', day, '12:00:00'), 1);
  // sale at 08:00: nothing before; later running 1, 0, 1; lowest 0
  assert.equal(await minQtyFrom(stub, 'X', 'W', day, '08:00:00'), 0);
});

test("item codes with '/' are refused", async () => {
  const { result } = await tool('request_confirmation', {}, sale({ items: [{ item_code: 'PA2293/94', rate: 100 }] }));
  assert.match(result.error, /contains '\/'/);
});

test('selling a stone never bought is refused (bot pre-check and ERPNext NegativeStockError)', async () => {
  const { result } = await tool('request_confirmation', {}, sale({ items: [{ item_code: 'R-17', description: 'ruby lot', rate: 9000 }] }));
  assert.match(result.error, /R17 is not in stock/);
  assert.equal(erp.get('Item', 'R17-TC'), null, 'no orphan Item created by a refused sale');

  erp.create('Item', { item_code: 'X1-TC', item_group: 'Products', is_stock_item: 1, is_sales_item: 1, is_purchase_item: 1, stock_uom: 'Nos' });
  assert.throws(() => erp.create('Sales Invoice', {
    company: COMPANY, customer: 'Siam Jewels', currency: 'THB', docstatus: 1, update_stock: 1,
    items: [{ item_code: 'X1-TC', qty: 1, rate: 10, income_account: '4110 - Sales - TC', warehouse: 'Stores - TC' }],
  }), /NegativeStockError/);
});

test('back-dated sale before the stone was bought is refused', async () => {
  const yesterday = addDays(TODAY, -1);
  await confirmAndSave(bill({ category_code: '5000', counterparty_name: 'Chanthaburi Gems', payment_terms: 'net_0',
    items: [{ item_code: 'BD1', description: 'spinel', rate: 3000 }] }));
  const draft = sale({ transaction_date: yesterday, items: [{ item_code: 'bd1', rate: 5000 }] });
  const { result } = await tool('request_confirmation', {}, draft);
  assert.match(result.error, new RegExp(`BD1 is not in stock on ${yesterday}`));
  assert.throws(() => erp.create('Sales Invoice', {
    company: COMPANY, customer: 'Siam Jewels', currency: 'THB', docstatus: 1, update_stock: 1, set_posting_time: 1, posting_date: yesterday,
    items: [{ item_code: 'BD1-TC', qty: 1, rate: 10, income_account: '4110 - Sales - TC', warehouse: 'Stores - TC' }],
  }), /NegativeStockError/);
  // Dated today it sells.
  await confirmAndSave(sale({ items: [{ item_code: 'bd1', rate: 5000 }] }));
  assert.equal(bin('BD1').actual_qty, 0);
});

test('allow_negative_stock: a valued stone can go below zero, a never-valued one cannot', async () => {
  erp.get('Stock Settings', 'Stock Settings').allow_negative_stock = 1;
  try {
    // never bought: ERPNext has no valuation rate to book COGS at
    const { result } = await tool('request_confirmation', {}, sale({ items: [{ item_code: 'neg-1', description: 'consignment', rate: 500 }] }));
    assert.match(result.error, /NEG1 has never been bought/);
    assert.throws(() => erp.create('Sales Invoice', {
      company: COMPANY, customer: 'Siam Jewels', currency: 'THB', docstatus: 1, update_stock: 1,
      items: [{ item_code: 'X1-TC', qty: 1, rate: 10, income_account: '4110 - Sales - TC', warehouse: 'Stores - TC' }],
    }), /Valuation Rate/);
    // PA2293 was bought at 20,000 and sold: a second sale takes it to −1 at that valuation
    const r = await confirmAndSave(sale({ items: [{ item_code: 'PA2293', description: 'ruby 7.68ct', rate: 45000 }] }));
    assert.equal(bin('PA2293').actual_qty, -1);
    assert.equal(gl(r.erpnext_name)['5111 - Cost of Goods Sold - TC'], 20000);
  } finally {
    erp.get('Stock Settings', 'Stock Settings').allow_negative_stock = 0;
  }
});

test('a stock line on a cash transaction is refused (cash JEs cannot move stock)', async () => {
  const { result } = await tool('request_confirmation', {}, {
    transaction_type: 'cash', direction: 'income', currency: 'THB', transaction_date: TODAY, category_code: '4000',
    payment_account_id: ids.cash, items: [{ item_code: 'pa2293', rate: 100 }],
  });
  assert.match(result.error, /invoice\/bill/);
});

test('query_stock: on-hand list, single item, unknown item, stock value', async () => {
  await confirmAndSave(bill({
    category_code: '5000', counterparty_name: 'Chanthaburi Gems', payment_terms: 'net_0',
    items: [
      { item_code: 'SP-01', description: 'blue sapphire 3.1ct', qty: 1, rate: 30000 },
      { item_code: 'em-7', description: 'emerald pair', qty: 2, rate: 12500 },
    ],
  }));
  let { result } = await tool('query_stock');
  assert.deepEqual(result.rows.map((x) => [x.item_code, x.qty, x.valuation_rate, x.stock_value, x.warehouse]), [
    ['EM7', 2, 12500, 25000, 'Stores'],
    ['NC1', 1, 10700, 10700, 'Stores'],
    ['PA2293', -1, 20000, -20000, 'Stores'],
    ['SP01', 1, 30000, 30000, 'Stores'],
    ['TW2', 2, 935.51, 1871.02, 'Stores'],
    ['ทับทิม01', 1, 1000, 1000, 'Stores'],
    ['ไพลิน01', 1, 2000, 2000, 'Stores'],
  ]);
  // 25,000 + 10,700 − 20,000 + 30,000 + 1,871.02 + 1,000 + 2,000
  assert.equal(result.total_value, 50571.02);
  assert.equal(result.currency, 'THB');
  assert.equal(result.rows[0].item_name, 'EM-7 emerald pair', 'item_name keeps the code as typed');

  ({ result } = await tool('query_stock', { item_code: 'bd-1' }));
  assert.equal(result.message, 'not_in_stock');
  assert.equal(result.rows[0].qty, 0);
  ({ result } = await tool('query_stock', { item_code: 'ｐａ－２２９３' }));
  assert.equal(result.rows[0].item_code, 'PA2293', 'full-width code finds the same stone');
  ({ result } = await tool('query_stock', { item_code: 'zz-404' }));
  assert.equal(result.message, 'unknown_item');
  ({ result } = await tool('query_stock', { search: 'sapphire' }));
  assert.deepEqual(result.rows.map((x) => x.item_code), ['SP01', 'ไพลิน01'], 'search covers item_name');
});
