/**
 * One-off: fix the previous test JE (ACC-JV-2026-00001).
 *   1. Replace category account 5223 (Misc) → 5204 (Entertainment Expenses)
 *   2. Submit it (docstatus 0 → 1) so it actually counts in the ledger
 *
 * Safe to delete after running.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const erpnext = require('../src/erpnext');

const JE_NAME = process.argv[2] || 'ACC-JV-2026-00001';
const OLD_ACCOUNT_PREFIX = '5223 - ';
const NEW_ACCOUNT_PREFIX = '5204 - ';

(async () => {
  const user = {
    erpnext_company: process.env.ERPNEXT_COMPANY_DEFAULT || 'Test Trading Company',
    erpnext_api_key: process.env.ERPNEXT_API_KEY,
    erpnext_api_secret: process.env.ERPNEXT_API_SECRET,
  };
  const erp = erpnext.forUser(user);

  console.log(`[fix-je] fetching ${JE_NAME}...`);
  const before = (await erp.getResource('Journal Entry', JE_NAME)).data;
  console.log(`[fix-je] status before: ${before.docstatus} (${before.docstatus === 0 ? 'Draft' : 'Submitted'})`);

  // Look up the target account name (5204 - ...) for the company
  const newAccount = (await erp.listAccounts({
    filters: [
      ['name', 'like', `${NEW_ACCOUNT_PREFIX}%`],
      ['company', '=', erp.company],
      ['is_group', '=', 0],
    ],
    limit: 1,
  })).data[0]?.name;

  if (!newAccount) {
    throw new Error(`Could not find new account starting with "${NEW_ACCOUNT_PREFIX}" in company ${erp.company}`);
  }
  console.log(`[fix-je] new account: ${newAccount}`);

  // Rewrite the accounts list — replace any line whose account starts with OLD prefix
  const newAccounts = before.accounts.map((row) => {
    if (row.account && row.account.startsWith(OLD_ACCOUNT_PREFIX)) {
      return { ...row, account: newAccount };
    }
    return row;
  });

  // 1. UPDATE the draft with corrected accounts (must stay docstatus=0 for an update)
  console.log('[fix-je] updating accounts...');
  await erp.updateResource('Journal Entry', JE_NAME, {
    accounts: newAccounts,
  });

  // 2. RE-FETCH to get fresh modified timestamp (Frappe optimistic locking)
  const fresh = (await erp.getResource('Journal Entry', JE_NAME)).data;

  // 3. SUBMIT via Frappe's client.submit, passing the FULL fresh doc body
  console.log('[fix-je] submitting...');
  await erp._fetch('POST', '/api/method/frappe.client.submit', {
    doc: fresh,
  });

  // Verify
  const after = (await erp.getResource('Journal Entry', JE_NAME)).data;
  console.log('[fix-je] status after:', after.docstatus, '(', after.docstatus === 1 ? 'Submitted ✓' : 'Draft', ')');
  console.log('[fix-je] entries now:');
  for (const e of after.accounts) {
    const side = e.debit_in_account_currency > 0 ? `Dr ${e.debit_in_account_currency}` : `Cr ${e.credit_in_account_currency}`;
    console.log(`  ${side.padEnd(18)} ${e.account}`);
  }

  process.exit(0);
})().catch((err) => {
  console.error('[fix-je] error:', err.message);
  if (err.response) console.error('  response:', JSON.stringify(err.response).slice(0, 500));
  process.exit(1);
});
