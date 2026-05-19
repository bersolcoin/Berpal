/**
 * Re-apply the bot-user role list to every tenant's ERPNext User.
 * Use this to fix tenants provisioned before the role-PUT fix landed
 * (Frappe's User create endpoint silently drops the `roles` child
 * table on insert, leaving the user with no doctype permissions).
 *
 *   node scripts/repair-bot-user-roles.js                 # all tenants
 *   node scripts/repair-bot-user-roles.js --user 4        # one users.id
 *   node scripts/repair-bot-user-roles.js --email bot+85259608836@berpal.local
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const { getAdminClient } = require('../src/erp-admin');

// Keep in sync with ROLES_FOR_BOT_USER in src/erp-sync/provision.js.
const ROLES = [
  { role: 'System Manager' },
  { role: 'Accounts Manager' },
  { role: 'Accounts User' },
  { role: 'Sales Manager' },
  { role: 'Sales User' },
  { role: 'Purchase Manager' },
  { role: 'Purchase User' },
  { role: 'Stock Manager' },
  { role: 'Stock User' },
  { role: 'Item Manager' },
];

(async () => {
  await init();
  const admin = getAdminClient();

  const args = process.argv.slice(2);
  let userId = null, email = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') userId = parseInt(args[i + 1], 10);
    if (args[i] === '--email') email = args[i + 1];
  }

  let where = `erpnext_company IS NOT NULL`;
  const params = [];
  if (userId) { params.push(userId); where += ` AND id = $${params.length}`; }
  if (email)  { params.push(email);  where += ` AND $${params.length} = 'bot+' || REPLACE(REPLACE(phone, '+', ''), ' ', '') || '@berpal.local'`; }

  const u = await query(
    `SELECT id, phone, erpnext_company FROM users WHERE ${where} ORDER BY id`,
    params
  );
  if (!u.rowCount) {
    console.log('No tenants matched. Nothing to repair.');
    process.exit(0);
  }

  for (const row of u.rows) {
    const botEmail = `bot+${String(row.phone).replace(/[^0-9]/g, '')}@berpal.local`;
    try {
      // user_type MUST be "System User" — Website Users get rejected
      // on every /api/resource/* call regardless of roles. Set both
      // in the same PUT.
      await admin.updateResource('User', botEmail, {
        user_type: 'System User',
        roles: ROLES,
      });
      // Frappe caches per-user permissions on first read. If the user
      // was created with no roles (initial insert dropping them) and
      // then made any API call, the cache holds "no perms" indefinitely.
      // Clear it so the freshly PUT'd roles take effect immediately.
      try {
        await admin.callMethod('frappe.clear_cache', { user: botEmail });
      } catch (cacheErr) {
        console.warn(`  cache-clear warning: ${cacheErr.message}`);
      }
      console.log(`✓ user.id=${row.id} (${row.erpnext_company}) — user_type + roles re-applied + cache cleared on ${botEmail}`);
    } catch (err) {
      console.error(`× user.id=${row.id} ${botEmail} — ${err.message}`);
    }
  }
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
