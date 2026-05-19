/**
 * Convert an existing tenant to the per-tenant fence model:
 *   1. Re-apply roles (now WITHOUT System Manager — fence requires it gone)
 *   2. Create per-tenant Customer / Supplier / Item Group
 *   3. Apply User Permission rows (Company + 3 groups, apply_to_all_doctypes=1)
 *   4. Migrate existing Customers / Suppliers / Items into the per-tenant groups
 *      (without migration the bot would lose visibility on rows created
 *       under the old default groups)
 *
 *   node scripts/harden-tenant.js                # every tenant
 *   node scripts/harden-tenant.js --user 4       # one tenant
 *   node scripts/harden-tenant.js --user 4 --dry # show what WOULD change
 *
 * Idempotent — safe to re-run.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const { getAdminClient } = require('../src/erp-admin');
const { ensureCustomerGroup, ensureSupplierGroup, getCustomerGroupName, getSupplierGroupName } = require('../src/erp-sync/party-group');
const { ensureCompanyItemGroup, getCompanyItemGroupName } = require('../src/erp-sync/item-group');
const { applyTenantFence } = require('../src/erp-sync/user-permission');

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
  const adminErp = {
    getResource: (dt, n) => admin.getResource(dt, n),
    createResource: (dt, d) => admin.createResource(dt, d),
    updateResource: (dt, n, d) => admin.updateResource(dt, n, d),
    listResource: (dt, args) => admin.listResource(dt, args),
  };

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  let userId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') userId = parseInt(args[i + 1], 10);
  }

  const u = await query(
    `SELECT id, phone, erpnext_company, erpnext_company_abbr FROM users
      WHERE erpnext_company IS NOT NULL
        AND erpnext_company_abbr IS NOT NULL
        ${userId ? 'AND id = $1' : ''}
      ORDER BY id`,
    userId ? [userId] : []
  );
  if (!u.rowCount) {
    console.log('No tenants to harden.');
    process.exit(0);
  }

  for (const row of u.rows) {
    const botEmail = `bot+${String(row.phone).replace(/[^0-9]/g, '')}@berpal.local`;
    const abbr = row.erpnext_company_abbr;
    const itemGroup = getCompanyItemGroupName(abbr);
    const customerGroup = getCustomerGroupName(abbr);
    const supplierGroup = getSupplierGroupName(abbr);

    console.log(`\n═══ user.id=${row.id} ${row.erpnext_company} (abbr=${abbr}) ═══`);
    console.log(`  bot:          ${botEmail}`);
    console.log(`  groups:       ${itemGroup} / ${customerGroup} / ${supplierGroup}`);

    if (dryRun) {
      console.log('  --dry: skipping writes.');
      continue;
    }

    // 1. Roles + user_type (no System Manager — fence requires its absence)
    try {
      await admin.updateResource('User', botEmail, {
        user_type: 'System User',
        roles: ROLES,
      });
      console.log(`  ✓ roles updated (${ROLES.length}, no System Manager)`);
    } catch (err) {
      console.error(`  × role update failed: ${err.message}`);
      continue;
    }

    // 2. Per-tenant groups
    try {
      await ensureCompanyItemGroup(adminErp, abbr);
      await ensureCustomerGroup(adminErp, abbr);
      await ensureSupplierGroup(adminErp, abbr);
      console.log('  ✓ groups ensured');
    } catch (err) {
      console.error(`  × group ensure failed: ${err.message}`);
      continue;
    }

    // 3. User Permission fence
    try {
      await applyTenantFence(admin, {
        user: botEmail,
        company: row.erpnext_company,
        customerGroup,
        supplierGroup,
        itemGroup,
      });
      console.log('  ✓ fence applied (Company + 3 groups, apply_to_all_doctypes=1)');
    } catch (err) {
      console.error(`  × fence apply failed: ${err.message}`);
      continue;
    }

    // 4. Migrate existing rows under default groups → tenant groups.
    // Bot's User Permission for Customer Group / Supplier Group / Item
    // Group would otherwise hide records created under the old defaults.
    await migrateGroup(admin, 'Customer', 'customer_group', customerGroup, ['Individual', 'All Customer Groups'], row);
    await migrateGroup(admin, 'Supplier', 'supplier_group', supplierGroup, ['All Supplier Groups'], row);
    await migrateGroup(admin, 'Item', 'item_group', itemGroup, ['All Item Groups', 'Products', 'Services', 'Sub Assemblies', 'Raw Material', 'Consumable'], row);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

/**
 * Move rows under old default groups into the per-tenant group.
 * Only touches rows the admin can see — but the admin has no fence,
 * so we filter ourselves by ownership signal where possible.
 *
 * For Customer/Supplier, "ownership" isn't a doctype field; instead
 * we walk Berpal's counterparty_cache for THIS user.id and re-assign
 * each erpnext_name. For Item we walk Berpal-known items via the
 * generic GEN-SALE/GEN-PURCHASE codes + the abbr suffix convention.
 */
async function migrateGroup(admin, doctype, groupField, targetGroup, oldDefaults, userRow) {
  const cacheDoctype = doctype === 'Item' ? null : doctype;
  let names = [];

  if (cacheDoctype) {
    const r = await query(
      `SELECT DISTINCT erpnext_name FROM counterparty_cache
        WHERE owner_user_id = $1 AND erpnext_doctype = $2 AND erpnext_name IS NOT NULL`,
      [userRow.id, cacheDoctype]
    );
    names = r.rows.map((x) => x.erpnext_name);
  } else {
    // For Item: anything ending in "- <ABBR>" is this tenant's.
    const r = await admin.listResource('Item', {
      filters: [
        ['item_code', 'like', `%-${userRow.erpnext_company_abbr}`],
      ],
      fields: ['name', groupField],
      limit: 500,
    });
    names = (r.data || []).map((x) => x.name);
  }

  if (!names.length) {
    console.log(`  ${doctype} migrate: 0 rows`);
    return;
  }

  let moved = 0;
  for (const n of names) {
    try {
      const existing = await admin.getResource(doctype, n);
      const currentGroup = existing.data?.[groupField];
      if (currentGroup === targetGroup) continue;
      if (oldDefaults.length && !oldDefaults.includes(currentGroup) && currentGroup !== null) {
        // Already in some other custom group — don't overwrite blindly.
        continue;
      }
      await admin.updateResource(doctype, n, { [groupField]: targetGroup });
      moved++;
    } catch (err) {
      console.warn(`    skipped ${n}: ${err.message}`);
    }
  }
  console.log(`  ${doctype} migrate: ${moved}/${names.length} moved into "${targetGroup}"`);
}
