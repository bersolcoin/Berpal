/**
 * One-time backfill: for every contact that currently exists on only one
 * side (Customer XOR Supplier), create the missing side too. After this,
 * every contact has matching Customer + Supplier records and the
 * /contacts view shows "Both" instead of "Customer" / "Supplier" only.
 *
 * Safe to re-run — resolveOrCreateCustomer / resolveOrCreateSupplier
 * already short-circuit if the record exists.
 *
 *   node scripts/dual-up-contacts.js
 *   node scripts/dual-up-contacts.js --user 1     # restrict to one user
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const erpnext = require('../src/erpnext');
const { resolveOrCreateCustomer } = require('../src/erp-sync/customer');
const { resolveOrCreateSupplier } = require('../src/erp-sync/supplier');

(async () => {
  await init();

  const args = process.argv.slice(2);
  let onlyUserId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') onlyUserId = parseInt(args[i + 1], 10);
  }

  const users = await query(
    `SELECT id, phone, erpnext_company, erpnext_api_key, erpnext_api_secret,
            default_currency, reporting_currency
       FROM users
      WHERE erpnext_api_key IS NOT NULL
        AND erpnext_api_secret IS NOT NULL
        AND erpnext_company IS NOT NULL
        ${onlyUserId ? 'AND id = $1' : ''}`,
    onlyUserId ? [onlyUserId] : []
  );

  if (!users.rowCount) {
    console.log('No users to process.');
    process.exit(0);
  }

  for (const user of users.rows) {
    user.reporting_currency = user.reporting_currency || user.default_currency;
    console.log(`\n── user.id=${user.id} (${user.phone}) → ${user.erpnext_company}`);

    const erp = erpnext.forUser(user);

    // Pull contacts grouped by name with the doctype set they appear in.
    const rows = (await query(
      `SELECT name,
              MAX(CASE WHEN erpnext_doctype = 'Customer' THEN erpnext_name END) AS customer_name,
              MAX(CASE WHEN erpnext_doctype = 'Supplier' THEN erpnext_name END) AS supplier_name,
              MIN(phone) AS phone,
              MIN(email) AS email
         FROM counterparty_cache
        WHERE owner_user_id = $1
        GROUP BY name`,
      [user.id]
    )).rows;

    let created = 0, skipped = 0;
    for (const row of rows) {
      try {
        if (row.customer_name && !row.supplier_name) {
          await resolveOrCreateSupplier(user, erp, row.name, {
            phone: row.phone,
            email: row.email,
            _skipEagerOtherSide: true,
          });
          console.log(`  + Supplier for "${row.name}"`);
          created += 1;
        } else if (row.supplier_name && !row.customer_name) {
          await resolveOrCreateCustomer(user, erp, row.name, {
            phone: row.phone,
            email: row.email,
            _skipEagerOtherSide: true,
          });
          console.log(`  + Customer for "${row.name}"`);
          created += 1;
        } else {
          skipped += 1;
        }
      } catch (err) {
        console.error(`  × "${row.name}": ${err.message}`);
      }
    }
    console.log(`  created=${created} skipped=${skipped} (already dual-sided)`);
  }

  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
