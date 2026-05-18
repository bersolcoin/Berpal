/**
 * One-time backfill: set users.erpnext_company_abbr by fetching each
 * user's Company.abbr from ERPNext. Safe to re-run (only touches rows
 * where abbr is currently NULL).
 *
 *   node scripts/backfill-company-abbr.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const erpnext = require('../src/erpnext');

(async () => {
  await init();

  const r = await query(
    `SELECT id, phone, erpnext_company, erpnext_api_key, erpnext_api_secret
       FROM users
      WHERE erpnext_company IS NOT NULL
        AND erpnext_company_abbr IS NULL
        AND erpnext_api_key IS NOT NULL
        AND erpnext_api_secret IS NOT NULL`
  );

  if (!r.rowCount) {
    console.log('Nothing to backfill — all users already have an abbr.');
    process.exit(0);
  }

  for (const user of r.rows) {
    try {
      const erp = erpnext.forUser(user);
      const comp = await erp.getResource('Company', user.erpnext_company);
      const abbr = comp.data?.abbr;
      if (!abbr) {
        console.warn(`! user.id=${user.id} (${user.phone}): no abbr on Company "${user.erpnext_company}"`);
        continue;
      }
      await query(
        `UPDATE users SET erpnext_company_abbr = $1, updated_at = $2 WHERE id = $3`,
        [abbr, new Date().toISOString(), user.id]
      );
      console.log(`✓ user.id=${user.id} (${user.phone}) → "${abbr}"`);
    } catch (err) {
      console.error(`× user.id=${user.id} (${user.phone}): ${err.message}`);
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
