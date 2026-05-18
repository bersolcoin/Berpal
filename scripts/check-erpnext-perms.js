/**
 * Check what ERPNext user our existing API key belongs to,
 * and whether that user has the roles needed for Company / User creation.
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

  console.log('Checking key against:', erp.baseUrl);
  console.log('');

  // 1. Who am I?
  const me = await erp.callMethod('frappe.auth.get_logged_user');
  const myEmail = me.message;
  console.log(`Logged in as: ${myEmail}`);

  // 2. What roles does this user have?
  const userResult = await erp.getResource('User', myEmail);
  const roles = (userResult.data.roles || []).map((r) => r.role);
  console.log(`Roles: ${roles.join(', ') || '(none)'}`);

  // 3. Can this key create Companies + Users? Check by trying to read the
  //    Company doctype's permission list — Administrator-equivalent roles
  //    will see it.
  const needed = ['System Manager', 'Administrator'];
  const hasAdmin = roles.some((r) => needed.includes(r));
  console.log('');
  if (hasAdmin) {
    console.log('✓ This key CAN create Companies + Users (has admin role).');
    console.log('  → Reuse for auto-provisioning. No separate admin key needed.');
  } else {
    console.log('✗ This key does NOT have admin role.');
    console.log('  → For auto-provisioning, create a new ERPNext user with role "System Manager",');
    console.log('    generate keys, and add to .env as ERPNEXT_ADMIN_API_KEY / ERPNEXT_ADMIN_API_SECRET.');
  }

  process.exit(0);
})().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
