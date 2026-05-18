/**
 * Set the business_type on a user row without re-running onboarding.
 * Useful for seeding test users to a specific mode.
 *
 *   node scripts/set-business-type.js +66838883866 both
 *   node scripts/set-business-type.js +66838883866 product
 *   node scripts/set-business-type.js +66838883866 service
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

const VALID = new Set(['service', 'product', 'both']);

(async () => {
  const phone = process.argv[2];
  const type = process.argv[3];

  if (!phone || !VALID.has(type)) {
    console.error('Usage: node scripts/set-business-type.js <phone> <service|product|both>');
    process.exit(1);
  }

  // Ensure the column exists — runs the same idempotent migrations the
  // server runs on boot, so the script works even if the dev server
  // hasn't been restarted since the column was added.
  await init();

  const r = await query(
    `UPDATE users SET business_type = $1, updated_at = $2
       WHERE phone = $3
       RETURNING id, phone, display_name, business_type`,
    [type, new Date().toISOString(), phone]
  );
  if (!r.rowCount) {
    console.log(`No user with phone ${phone}.`);
    process.exit(1);
  }
  console.log('Updated:', r.rows[0]);
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
