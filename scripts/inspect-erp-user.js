/**
 * Read back the ERPNext User doc for a tenant so we can see exactly
 * what user_type / roles / enabled state are actually persisted.
 *
 *   node scripts/inspect-erp-user.js --user 4
 *   node scripts/inspect-erp-user.js --email bot+85259608836@berpal.local
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const { getAdminClient } = require('../src/erp-admin');
const { listForUser } = require('../src/erp-sync/user-permission');

(async () => {
  await init();
  const admin = getAdminClient();

  const args = process.argv.slice(2);
  let userId = null, email = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') userId = parseInt(args[i + 1], 10);
    if (args[i] === '--email') email = args[i + 1];
  }

  if (userId) {
    const r = await query(`SELECT phone, erpnext_company FROM users WHERE id = $1`, [userId]);
    if (!r.rowCount) { console.error(`No DB user with id=${userId}`); process.exit(2); }
    email = `bot+${String(r.rows[0].phone).replace(/[^0-9]/g, '')}@berpal.local`;
    console.log(`DB user.id=${userId} → ${r.rows[0].erpnext_company} → bot email=${email}\n`);
  }
  if (!email) {
    console.error('Need --user <id> or --email <addr>');
    process.exit(1);
  }

  try {
    const u = await admin.getResource('User', email);
    const data = u.data || {};
    console.log(`ERPNext User: ${data.name}`);
    console.log(`  enabled:        ${data.enabled}`);
    console.log(`  user_type:      ${data.user_type || '(unset)'}     ← MUST be "System User" for API access`);
    console.log(`  api_key:        ${data.api_key ? 'set' : '(none)'}`);
    console.log(`  language:       ${data.language || '(default)'}`);
    console.log(`  time_zone:      ${data.time_zone || '(default)'}`);
    console.log(`  roles (${(data.roles || []).length}):`);
    for (const r of data.roles || []) {
      console.log(`    - ${r.role}`);
    }
    if (!data.roles || data.roles.length === 0) {
      console.log('    (no roles — this is why doctype access fails)');
    }
    const blocked = data.block_modules || [];
    console.log(`  block_modules (${blocked.length}):`);
    for (const b of blocked) {
      console.log(`    - ${b.module}`);
    }
    if (blocked.some((b) => /Buying|Accounts|Selling/i.test(b.module))) {
      console.log('    ⚠  A blocked module here overrides roles — Supplier sits under Buying.');
    }
    if (data.user_type !== 'System User') {
      console.log('\n⚠  user_type is not "System User" — REST API calls from this user will fail regardless of roles.');
    }

    // User Permission fence
    const perms = await listForUser(admin, email);
    console.log(`  user_permissions (${perms.length}):`);
    for (const p of perms) {
      console.log(`    - ${p.allow.padEnd(16)} = ${p.for_value}   ${p.apply_to_all_doctypes ? '(all doctypes)' : '(named only)'}`);
    }
    if (perms.length === 0) {
      console.log('    ⚠  NO User Permissions — this user can read/write across ALL tenants in this ERPNext instance.');
    }
    const hasSystemMgr = (data.roles || []).some((r) => r.role === 'System Manager');
    if (hasSystemMgr && perms.length > 0) {
      console.log('    ⚠  Has System Manager role — bypasses User Permissions, defeating the fence.');
    }
  } catch (err) {
    console.error(`Error reading User ${email}: ${err.message}`);
    process.exit(3);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
