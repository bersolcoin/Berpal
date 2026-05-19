/**
 * Issue (or rotate) per-tenant bot-user API credentials for an existing
 * users row that was created outside the onboarding flow and is
 * currently using the Administrator key from .env.
 *
 * Symptom this fixes: erpnext.forUser(user) authenticates as
 * Administrator, sees every other tenant's data, ignores fences.
 *
 *   node scripts/issue-bot-user-keys.js --user 1           # rotate keys for users.id=1
 *   node scripts/issue-bot-user-keys.js --user 1 --dry     # show what WOULD change
 *
 * What it does:
 *   1. Ensure the bot user exists in ERPNext (create with correct roles
 *      and user_type='System User' if missing).
 *   2. Force-PUT user_type + roles (Frappe drops the roles child table
 *      on insert in some versions).
 *   3. Clear Frappe's per-user permission cache.
 *   4. Call frappe.core.doctype.user.user.generate_keys → fresh
 *      api_key / api_secret.
 *   5. UPDATE users.erpnext_api_key / users.erpnext_api_secret in PG.
 *
 * Does NOT apply the User Permission fence — run harden-tenant.js
 * --user N afterwards for that.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const { getAdminClient } = require('../src/erp-admin');

// Keep in sync with ROLES_FOR_BOT_USER in src/erp-sync/provision.js.
const ROLES = [
  { role: 'Accounts Manager' }, { role: 'Accounts User' }, { role: 'Report Manager' },
  { role: 'Sales Manager' }, { role: 'Sales Master Manager' }, { role: 'Sales User' },
  { role: 'Purchase Manager' }, { role: 'Purchase Master Manager' }, { role: 'Purchase User' },
  { role: 'Stock Manager' }, { role: 'Stock User' }, { role: 'Item Manager' },
  { role: 'HR Manager' }, { role: 'HR User' },
  { role: 'Manufacturing Manager' }, { role: 'Manufacturing User' },
  { role: 'Projects Manager' }, { role: 'Projects User' },
  { role: 'Delivery Manager' }, { role: 'Delivery User' },
  { role: 'Fleet Manager' },
  { role: 'Maintenance Manager' }, { role: 'Maintenance User' },
  { role: 'Quality Manager' },
  { role: 'Fulfillment User' }, { role: 'Marketing Manager' }, { role: 'Support Team' },
];

(async () => {
  await init();
  const admin = getAdminClient();

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  let userId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') userId = parseInt(args[i + 1], 10);
  }
  if (!userId) {
    console.error('Usage: node scripts/issue-bot-user-keys.js --user <id> [--dry]');
    process.exit(1);
  }

  const r = await query(
    `SELECT id, phone, display_name, erpnext_company, erpnext_api_key
       FROM users WHERE id = $1`,
    [userId]
  );
  if (!r.rowCount) {
    console.error(`No users row with id=${userId}`);
    process.exit(2);
  }
  const u = r.rows[0];
  const botEmail = `bot+${String(u.phone).replace(/[^0-9]/g, '')}@berpal.local`;

  console.log(`user.id=${u.id}  company=${u.erpnext_company}  phone=${u.phone}`);
  console.log(`bot email:        ${botEmail}`);
  console.log(`current PG key:   ${u.erpnext_api_key ? u.erpnext_api_key.slice(0, 6) + '…' : '(none)'}`);

  if (dryRun) {
    console.log('--dry: skipping writes.');
    process.exit(0);
  }

  // 1. Ensure bot user exists.
  let userExists = false;
  try {
    await admin.getResource('User', botEmail);
    userExists = true;
    console.log(`✓ User exists in ERPNext`);
  } catch {
    const personName = (u.display_name || u.erpnext_company || 'Bot').trim();
    const [firstName, ...rest] = personName.split(/\s+/);
    const lastName = rest.join(' ');
    await admin.createResource('User', {
      email: botEmail,
      first_name: firstName,
      ...(lastName ? { last_name: lastName } : {}),
      send_welcome_email: 0,
      enabled: 1,
      user_type: 'System User',
      roles: ROLES,
    });
    console.log(`✓ Created User ${botEmail}`);
  }

  // 2. Force-PUT user_type + roles (idempotent; survives Frappe dropping
  //    the roles child table on insert).
  await admin.updateResource('User', botEmail, {
    user_type: 'System User',
    roles: ROLES,
  });
  console.log(`✓ user_type=System User + ${ROLES.length} roles applied (no System Manager)`);

  // 3. Clear per-user permission cache so the new roles take effect on
  //    the very first /api/resource/* call.
  try {
    await admin.callMethod('frappe.clear_cache', { user: botEmail });
    console.log(`✓ Frappe per-user cache cleared`);
  } catch (err) {
    console.warn(`  cache-clear warning: ${err.message}`);
  }

  // 4. Generate fresh API keys.
  let apiKey, apiSecret;
  try {
    const r2 = await admin.callMethod('frappe.core.doctype.user.user.generate_keys', {
      user: botEmail,
    });
    apiSecret = r2.message?.api_secret;
    const fresh = await admin.getResource('User', botEmail);
    apiKey = fresh.data?.api_key;
    if (!apiKey || !apiSecret) throw new Error('generate_keys returned empty key or secret');
    console.log(`✓ generate_keys issued new api_key=${apiKey.slice(0, 6)}…`);
  } catch (err) {
    console.error(`× generate_keys failed: ${err.message}`);
    process.exit(3);
  }

  // 5. Persist new keys to PG.
  const now = new Date().toISOString();
  await query(
    `UPDATE users
        SET erpnext_api_key = $1,
            erpnext_api_secret = $2,
            updated_at = $3
      WHERE id = $4`,
    [apiKey, apiSecret, now, userId]
  );
  console.log(`✓ PG users.id=${userId} updated with new bot-user keys`);

  console.log(`\nNext step: node scripts/harden-tenant.js --user ${userId}`);
  console.log(`           (creates groups + applies User Permission fence)`);
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
