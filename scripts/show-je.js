/**
 * Pretty-print a Journal Entry from ERPNext.
 * Usage: node scripts/show-je.js ACC-JV-2026-00001
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const erpnext = require('../src/erpnext');

const name = process.argv[2];
if (!name) {
  console.error('Usage: node scripts/show-je.js <JE-name>');
  console.error('  e.g.  node scripts/show-je.js ACC-JV-2026-00001');
  process.exit(1);
}

(async () => {
  const user = {
    erpnext_company: process.env.ERPNEXT_COMPANY_DEFAULT || 'Test Trading Company',
    erpnext_api_key: process.env.ERPNEXT_API_KEY,
    erpnext_api_secret: process.env.ERPNEXT_API_SECRET,
  };
  const erp = erpnext.forUser(user);

  const r = await erp.getResource('Journal Entry', name);
  const je = r.data;

  console.log('');
  console.log('────────────────────────────────────────────────────');
  console.log(`  ${je.name}`);
  console.log('────────────────────────────────────────────────────');
  console.log(`  Date:      ${je.posting_date}`);
  console.log(`  Type:      ${je.voucher_type}`);
  console.log(`  Company:   ${je.company}`);
  console.log(`  Status:    ${je.docstatus === 1 ? 'Submitted' : je.docstatus === 0 ? 'Draft' : 'Cancelled'}`);
  console.log(`  Remark:    ${je.user_remark || '(none)'}`);
  console.log('');
  console.log('  Entries:');
  for (const e of je.accounts || []) {
    const dr = e.debit_in_account_currency || 0;
    const cr = e.credit_in_account_currency || 0;
    const side = dr > 0 ? `Dr ${dr.toLocaleString()}` : `Cr ${cr.toLocaleString()}`;
    console.log(`    ${side.padEnd(18)}  ${e.account}`);
  }
  console.log('────────────────────────────────────────────────────');
  console.log('');

  process.exit(0);
})().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
