/**
 * Check whether the ERPNext Company has its multi-currency accounts set.
 * Specifically: exchange_gain_loss_account (the one we care about for
 * FX-diff on payments against foreign-currency invoices).
 *
 * Usage: node scripts/check-fx-account.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const erpnext = require('../src/erpnext');

(async () => {
  const user = {
    erpnext_company: process.env.ERPNEXT_COMPANY_DEFAULT || 'Test Trading Company',
    erpnext_api_key: process.env.ERPNEXT_API_KEY,
    erpnext_api_secret: process.env.ERPNEXT_API_SECRET,
  };
  const erp = erpnext.forUser(user);

  const r = await erp.getResource('Company', user.erpnext_company);
  const c = r.data;

  console.log('');
  console.log('────────────────────────────────────────────────────');
  console.log(`  Company: ${c.name}  (${c.abbr})`);
  console.log(`  Default currency: ${c.default_currency}`);
  console.log('────────────────────────────────────────────────────');
  console.log('  Accounting defaults:');
  console.log(`    Receivable Account:           ${c.default_receivable_account || '(unset)'}`);
  console.log(`    Payable Account:              ${c.default_payable_account || '(unset)'}`);
  console.log(`    Cash Account:                 ${c.default_cash_account || '(unset)'}`);
  console.log(`    Bank Account:                 ${c.default_bank_account || '(unset)'}`);
  console.log(`    Expense Account:              ${c.default_expense_account || '(unset)'}`);
  console.log(`    Income Account:               ${c.default_income_account || '(unset)'}`);
  console.log('');
  console.log('  Multi-currency / FX:');
  console.log(`    Exchange Gain/Loss Account:   ${c.exchange_gain_loss_account || '(UNSET — fix before testing FX payments)'}`);
  console.log(`    Unrealized Exchange G/L:      ${c.unrealized_exchange_gain_loss_account || '(unset — optional)'}`);
  console.log(`    Write Off Account:            ${c.write_off_account || '(unset)'}`);
  console.log(`    Round Off Account:            ${c.round_off_account || '(unset)'}`);
  console.log('────────────────────────────────────────────────────');

  // If FX account is missing, suggest the standard one and offer to find it.
  if (!c.exchange_gain_loss_account) {
    console.log('');
    console.log('  ⚠  Exchange Gain/Loss Account is NOT set on this Company.');
    console.log('     Without it, ERPNext will reject Payment Entries that settle a');
    console.log('     foreign-currency invoice at a different rate (the FX diff has');
    console.log('     no account to post to).');
    console.log('');
    console.log('     Searching the chart for likely candidates...');
    const accts = await erp.listResource('Account', {
      filters: [
        ['company', '=', user.erpnext_company],
        ['account_name', 'like', '%Exchange%'],
      ],
      fields: ['name', 'account_name', 'account_type', 'is_group'],
      limit: 20,
    });
    if (accts.data && accts.data.length) {
      console.log('     Candidates:');
      for (const a of accts.data) {
        console.log(`       ${a.name}   (type=${a.account_type || '-'}, is_group=${a.is_group})`);
      }
      console.log('');
      console.log('     To set: open Company in ERPNext → "Default Accounts" tab →');
      console.log('     set "Exchange Gain/Loss Account" to one of the above.');
    } else {
      console.log('     No account with "Exchange" in the name found.');
      console.log('     You may need to create one (Account Type: "Expense Account" or');
      console.log('     "Income Account", under the Indirect Expenses / Income group).');
    }
  } else {
    console.log('');
    console.log('  ✓  Exchange Gain/Loss Account is configured. Multi-currency');
    console.log('     payments will post FX diffs there automatically.');
  }
  console.log('');

  process.exit(0);
})().catch((err) => {
  console.error('error:', err.message);
  if (err.response) console.error('response:', JSON.stringify(err.response).slice(0, 600));
  process.exit(1);
});
