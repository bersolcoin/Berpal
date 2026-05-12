/**
 * Pretty-print a Sales Invoice from ERPNext.
 * Usage: node scripts/show-inv.js ACC-SINV-2026-00001
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const erpnext = require('../src/erpnext');

const name = process.argv[2];
if (!name) {
  console.error('Usage: node scripts/show-inv.js <Invoice-name>');
  process.exit(1);
}

(async () => {
  const user = {
    erpnext_company: process.env.ERPNEXT_COMPANY_DEFAULT || 'Test Trading Company',
    erpnext_api_key: process.env.ERPNEXT_API_KEY,
    erpnext_api_secret: process.env.ERPNEXT_API_SECRET,
  };
  const erp = erpnext.forUser(user);

  const r = await erp.getResource('Sales Invoice', name);
  const inv = r.data;

  console.log('');
  console.log('────────────────────────────────────────────────────');
  console.log(`  ${inv.name}`);
  console.log('────────────────────────────────────────────────────');
  console.log(`  Customer:       ${inv.customer}`);
  console.log(`  Posting:        ${inv.posting_date}`);
  console.log(`  Due:            ${inv.due_date}`);
  const baseCurrency = inv.company_currency || inv.base_currency || 'base';
  console.log(`  Currency:       ${inv.currency}${inv.conversion_rate && inv.conversion_rate !== 1 ? ` @ ${inv.conversion_rate}` : ''}`);
  console.log(`  Status:         ${inv.status} (docstatus=${inv.docstatus})`);
  console.log(`  Grand Total:    ${(inv.grand_total || 0).toLocaleString()} ${inv.currency}`);
  if (inv.base_grand_total && inv.currency !== baseCurrency) {
    console.log(`  In ${baseCurrency}:           ${inv.base_grand_total.toLocaleString()}`);
  }
  console.log(`  Outstanding:    ${(inv.outstanding_amount || 0).toLocaleString()} ${inv.currency}`);
  console.log('');
  console.log('  Line items:');
  for (const item of inv.items || []) {
    console.log(`    ${item.qty} × ${item.rate} = ${item.amount} ${inv.currency}  | ${item.item_code} — ${item.description}`);
    if (item.income_account) console.log(`         income: ${item.income_account}`);
  }
  console.log('────────────────────────────────────────────────────');
  console.log('');

  process.exit(0);
})().catch((err) => {
  console.error('error:', err.message);
  if (err.response) console.error('response:', JSON.stringify(err.response).slice(0, 600));
  process.exit(1);
});
