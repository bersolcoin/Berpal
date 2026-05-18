/**
 * Wipe a user's ERPNext bindings + caches so their next login routes
 * them back through /onboarding (where they'll provision a fresh
 * Company with the numbered chart of accounts).
 *
 * Keeps: id, phone, display_name, email, subscription_status
 * Clears: erpnext_company / abbr / api_key / api_secret,
 *         business_type, entity_type, nature_of_business, tax_id,
 *         address_line1/2, city, state_province, postal_code,
 *         country (back to default), default_currency (back to default),
 *         account_cache rows, counterparty_cache rows
 *
 * IMPORTANT: this does NOT touch ERPNext. Delete the orphan Company +
 * its dependents (Customers, Suppliers, Items, Warehouses, Accounts)
 * in the ERPNext UI BEFORE running this — otherwise the user's next
 * onboarding will collide on "Company already exists".
 *
 * Usage:
 *   node scripts/reset-user-onboarding.js +85258608836
 *   node scripts/reset-user-onboarding.js +85258608836 --yes   # skip confirm
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const readline = require('readline');
const { query, init } = require('../src/db');

(async () => {
  await init();

  const args = process.argv.slice(2);
  const phone = args.find((a) => !a.startsWith('--'));
  const autoConfirm = args.includes('--yes');

  if (!phone) {
    console.error('Usage: node scripts/reset-user-onboarding.js <phone> [--yes]');
    process.exit(1);
  }

  const r = await query(
    `SELECT id, phone, display_name, erpnext_company, erpnext_company_abbr
       FROM users WHERE phone = $1`,
    [phone]
  );
  if (!r.rowCount) {
    console.log(`No user with phone ${phone}.`);
    process.exit(1);
  }
  const u = r.rows[0];

  console.log('\nAbout to reset:');
  console.log(`  id:             ${u.id}`);
  console.log(`  phone:          ${u.phone}`);
  console.log(`  display_name:   ${u.display_name || '(none)'}`);
  console.log(`  erpnext_company: ${u.erpnext_company || '(none)'}`);
  console.log(`  abbr:           ${u.erpnext_company_abbr || '(none)'}`);
  console.log('\nThis will null all ERPNext + onboarding fields and wipe their caches.');
  console.log('Their NEXT login will route to /onboarding again.');
  console.log('Did you already delete the Company in ERPNext? Otherwise re-onboarding will collide.\n');

  if (!autoConfirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) =>
      rl.question('Type YES to proceed: ', (a) => { rl.close(); resolve(a.trim()); })
    );
    if (answer !== 'YES') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  const now = new Date().toISOString();
  const updated = await query(
    `UPDATE users SET
       erpnext_company = NULL,
       erpnext_company_abbr = NULL,
       erpnext_api_key = NULL,
       erpnext_api_secret = NULL,
       business_type = NULL,
       entity_type = NULL,
       nature_of_business = NULL,
       tax_id = NULL,
       address_line1 = NULL,
       address_line2 = NULL,
       city = NULL,
       state_province = NULL,
       postal_code = NULL,
       updated_at = $1
     WHERE id = $2
     RETURNING id`,
    [now, u.id]
  );

  const accCache = await query(
    `DELETE FROM account_cache WHERE user_id = $1 RETURNING id`,
    [u.id]
  );
  const cpCache = await query(
    `DELETE FROM counterparty_cache WHERE owner_user_id = $1 RETURNING id`,
    [u.id]
  );

  console.log(`\n✓ Reset users.id=${updated.rows[0].id}`);
  console.log(`✓ Cleared ${accCache.rowCount} account_cache rows`);
  console.log(`✓ Cleared ${cpCache.rowCount} counterparty_cache rows`);
  console.log('\nNext step: have them open /login and sign in — they\'ll land on /onboarding.');
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
