/**
 * List all Receivable / Payable accounts in ERPNext for this Company,
 * showing their currency. Helps debug "currency must match" errors on
 * multi-currency invoices.
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

  const r = await erp.listResource('Account', {
    filters: [
      ['company', '=', user.erpnext_company],
      ['account_type', 'in', ['Receivable', 'Payable']],
    ],
    fields: ['name', 'account_name', 'account_currency', 'account_type', 'parent_account', 'is_group'],
    limit: 100,
  });

  console.log('');
  for (const a of r.data) {
    console.log(
      `${a.account_currency || '?  '}  ${a.account_type.padEnd(11)}  ${a.is_group ? '[group]' : '       '}  ${a.name}   (parent: ${a.parent_account})`
    );
  }
  console.log('');
})().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
