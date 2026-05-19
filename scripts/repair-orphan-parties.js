/**
 * Repair contacts that were orphaned by the pre-fix counterparty_cache
 * clobber bug (UNIQUE(owner_user_id, name) without erpnext_doctype).
 *
 * Symptom: a tenant has a contact like "SS and co" that exists in
 * ERPNext as BOTH a Customer and a Supplier (eager dual-create did
 * its job), but only ONE side got migrated into the per-tenant group
 * by harden-tenant.js — because the cache row's erpnext_doctype field
 * was clobbered to whichever doctype was written last. From the fenced
 * bot's perspective the other side is invisible.
 *
 * This script walks DISTINCT names in counterparty_cache for the user
 * and reassigns customer_group / supplier_group for BOTH ERPNext docs
 * if they exist. Also re-seeds the cache (now that the constraint is
 * widened) so future reads see Customer + Supplier rows for each name.
 *
 *   node scripts/repair-orphan-parties.js --user 1
 *   node scripts/repair-orphan-parties.js --user 1 --dry
 *
 * Idempotent — safe to re-run.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const { getAdminClient } = require('../src/erp-admin');
const { getCustomerGroupName, getSupplierGroupName } = require('../src/erp-sync/party-group');

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
    console.error('Usage: node scripts/repair-orphan-parties.js --user <id> [--dry]');
    process.exit(1);
  }

  const u = await query(
    `SELECT id, phone, erpnext_company, erpnext_company_abbr
       FROM users WHERE id = $1`,
    [userId]
  );
  if (!u.rowCount) {
    console.error(`No users row with id=${userId}`);
    process.exit(2);
  }
  const userRow = u.rows[0];
  const abbr = userRow.erpnext_company_abbr;
  if (!abbr) {
    console.error(`users.id=${userId} has no erpnext_company_abbr — provisioning incomplete`);
    process.exit(3);
  }
  const customerGroup = getCustomerGroupName(abbr);
  const supplierGroup = getSupplierGroupName(abbr);

  console.log(`user.id=${userRow.id}  company=${userRow.erpnext_company}  abbr=${abbr}`);
  console.log(`targets:  customer_group="${customerGroup}"   supplier_group="${supplierGroup}"`);

  // Distinct names regardless of which doctype tag the cache row has.
  const r = await query(
    `SELECT DISTINCT name FROM counterparty_cache
       WHERE owner_user_id = $1 AND name IS NOT NULL
       ORDER BY name`,
    [userId]
  );
  if (!r.rowCount) {
    console.log('No counterparty_cache rows. Nothing to repair.');
    process.exit(0);
  }
  console.log(`names in cache: ${r.rowCount}\n`);

  let custMoved = 0, custFound = 0, suppMoved = 0, suppFound = 0;
  let custCacheUpserted = 0, suppCacheUpserted = 0;

  for (const { name } of r.rows) {
    // Look up by display field, not doc name — handles autoname cases.
    const custList = await admin.listResource('Customer', {
      filters: [['customer_name', '=', name]],
      fields: ['name', 'customer_name', 'customer_group', 'mobile_no', 'email_id'],
      limit: 1,
    });
    const supList = await admin.listResource('Supplier', {
      filters: [['supplier_name', '=', name]],
      fields: ['name', 'supplier_name', 'supplier_group', 'mobile_no', 'email_id'],
      limit: 1,
    });
    const cust = custList.data?.[0] || null;
    const sup = supList.data?.[0] || null;

    if (!cust && !sup) {
      console.log(`× "${name}"  no Customer or Supplier in ERPNext`);
      continue;
    }

    const line = [`• "${name}"`];

    if (cust) {
      custFound++;
      if (cust.customer_group !== customerGroup) {
        if (!dryRun) {
          await admin.updateResource('Customer', cust.name, { customer_group: customerGroup });
        }
        custMoved++;
        line.push(`Customer: ${cust.customer_group} → ${customerGroup}`);
      } else {
        line.push(`Customer: already in target`);
      }
      // Cache re-seed (Customer side)
      if (!dryRun) {
        const now = new Date().toISOString();
        const up = await query(
          `INSERT INTO counterparty_cache
             (owner_user_id, name, phone, email, erpnext_doctype, erpnext_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'Customer', $5, $6, $6)
           ON CONFLICT (owner_user_id, erpnext_doctype, name) DO UPDATE SET
             erpnext_name = EXCLUDED.erpnext_name,
             phone = COALESCE(counterparty_cache.phone, EXCLUDED.phone),
             email = COALESCE(counterparty_cache.email, EXCLUDED.email),
             updated_at = EXCLUDED.updated_at
           RETURNING (xmax = 0) AS inserted`,
          [userId, name, cust.mobile_no || null, cust.email_id || null, cust.name, now]
        );
        if (up.rows[0]?.inserted) custCacheUpserted++;
      }
    }

    if (sup) {
      suppFound++;
      if (sup.supplier_group !== supplierGroup) {
        if (!dryRun) {
          await admin.updateResource('Supplier', sup.name, { supplier_group: supplierGroup });
        }
        suppMoved++;
        line.push(`Supplier: ${sup.supplier_group} → ${supplierGroup}`);
      } else {
        line.push(`Supplier: already in target`);
      }
      if (!dryRun) {
        const now = new Date().toISOString();
        const up = await query(
          `INSERT INTO counterparty_cache
             (owner_user_id, name, phone, email, erpnext_doctype, erpnext_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'Supplier', $5, $6, $6)
           ON CONFLICT (owner_user_id, erpnext_doctype, name) DO UPDATE SET
             erpnext_name = EXCLUDED.erpnext_name,
             phone = COALESCE(counterparty_cache.phone, EXCLUDED.phone),
             email = COALESCE(counterparty_cache.email, EXCLUDED.email),
             updated_at = EXCLUDED.updated_at
           RETURNING (xmax = 0) AS inserted`,
          [userId, name, sup.mobile_no || null, sup.email_id || null, sup.name, now]
        );
        if (up.rows[0]?.inserted) suppCacheUpserted++;
      }
    }

    console.log(`  ${line.join('  |  ')}`);
  }

  console.log(`\nCustomer side: ${custFound} found, ${custMoved} reassigned, ${custCacheUpserted} cache rows inserted`);
  console.log(`Supplier side: ${suppFound} found, ${suppMoved} reassigned, ${suppCacheUpserted} cache rows inserted`);
  if (dryRun) console.log('(--dry: no writes performed)');
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
