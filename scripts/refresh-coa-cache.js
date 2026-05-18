/**
 * Refresh the chart-of-accounts cache for one or all users.
 * Use after initial deploy of the cache, or anytime you suspect drift
 * (manual ERPNext edits, partial creation failures, etc.).
 *
 *   node scripts/refresh-coa-cache.js            # all users with creds
 *   node scripts/refresh-coa-cache.js --user 1   # just users.id = 1
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const erpnext = require('../src/erpnext');
const { refreshCoaCache } = require('../src/erp-sync/coa-cache');

(async () => {
  await init();

  const args = process.argv.slice(2);
  let onlyId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') onlyId = parseInt(args[i + 1], 10);
  }

  const r = await query(
    `SELECT id, phone, erpnext_company, erpnext_api_key, erpnext_api_secret,
            reporting_currency, default_currency
       FROM users
      WHERE erpnext_company IS NOT NULL
        AND erpnext_api_key IS NOT NULL
        AND erpnext_api_secret IS NOT NULL
        ${onlyId ? 'AND id = $1' : ''}`,
    onlyId ? [onlyId] : []
  );

  if (!r.rowCount) {
    console.log('No users to refresh.');
    process.exit(0);
  }

  for (const u of r.rows) {
    u.reporting_currency = u.reporting_currency || u.default_currency;
    try {
      const erp = erpnext.forUser(u);
      const rows = await refreshCoaCache(u, erp);
      console.log(`✓ user.id=${u.id} (${u.phone}, ${u.erpnext_company}) → ${rows.length} accounts cached`);
    } catch (err) {
      console.error(`× user.id=${u.id} (${u.phone}): ${err.message}`);
    }
  }
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
