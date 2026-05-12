/**
 * Lists every Account in the user's ERPNext Company.
 * Useful to understand the chart names so we can map our category_codes
 * to the actual account names ERPNext uses.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const erpnext = require('../src/erpnext');

(async () => {
  // Build a synthetic user from .env so we don't need the DB
  const user = {
    erpnext_company: process.env.ERPNEXT_COMPANY_DEFAULT || 'Test Trading Company',
    erpnext_api_key: process.env.ERPNEXT_API_KEY,
    erpnext_api_secret: process.env.ERPNEXT_API_SECRET,
  };
  const erp = erpnext.forUser(user);

  console.log(`[list] company: ${user.erpnext_company}`);
  const r = await erp.listAccounts({ limit: 500 });
  const rows = r.data;

  // Sort by name (which usually starts with the code)
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // Group by account_type for readability
  const byType = {};
  for (const a of rows) {
    const t = a.account_type || (a.is_group ? '(group)' : '(none)');
    if (!byType[t]) byType[t] = [];
    byType[t].push(a);
  }

  for (const [type, list] of Object.entries(byType).sort()) {
    console.log(`\n── ${type} (${list.length}) ──`);
    for (const a of list) {
      const flag = a.is_group ? ' [group]' : '';
      console.log(`  ${a.name}${flag}  ${a.account_currency ? '[' + a.account_currency + ']' : ''}`);
    }
  }

  console.log(`\n[list] total: ${rows.length} accounts`);
  process.exit(0);
})().catch((err) => {
  console.error('[list] error:', err);
  process.exit(1);
});
