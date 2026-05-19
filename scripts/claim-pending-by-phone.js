/**
 * Claim any pending linked_transactions rows for a phone NOW (without
 * waiting for the buyer to re-onboard). The buyer must already exist
 * in the users table — this just runs the bind step manually and fires
 * the catch-up WhatsApp message.
 *
 *   node scripts/claim-pending-by-phone.js +61425811897
 *
 * Useful for repairing rows that landed before bindPendingByPhone
 * grew its catch-up send, or for rows whose buyer signed up before
 * the bind logic existed.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const { bindPendingByPhone } = require('../src/links/linked-transactions');

(async () => {
  await init();

  const phone = process.argv[2];
  if (!phone || !/^\+?\d+$/.test(phone.replace(/[\s-]/g, ''))) {
    console.error('Usage: node scripts/claim-pending-by-phone.js <phone>');
    console.error('       e.g. node scripts/claim-pending-by-phone.js +61425811897');
    process.exit(1);
  }

  // Find the user with this phone.
  const stripped = phone.startsWith('+') ? phone.slice(1) : phone;
  const plussed = phone.startsWith('+') ? phone : `+${phone}`;
  const u = await query(
    `SELECT id, phone, erpnext_company FROM users
      WHERE phone IN ($1, $2, $3) LIMIT 1`,
    [phone, stripped, plussed]
  );
  if (!u.rowCount) {
    console.error(`No user found with phone ${phone}. They must sign up (at least the users row) first.`);
    process.exit(2);
  }
  const user = u.rows[0];
  console.log(`Found user.id=${user.id} (${user.phone}, company=${user.erpnext_company || 'none yet'}).`);

  // List pending rows up front so we can show what's about to change.
  const pending = await query(
    `SELECT id, seller_user_id, seller_doc_name, currency, total_amount
       FROM linked_transactions
      WHERE buyer_user_id IS NULL
        AND status = 'pending_buyer_signup'
        AND buyer_phone IN ($1, $2, $3)`,
    [phone, stripped, plussed]
  );
  if (!pending.rowCount) {
    console.log(`No pending_buyer_signup rows match ${phone}. Nothing to claim.`);
    process.exit(0);
  }
  console.log(`Pending rows for ${phone}:`);
  for (const r of pending.rows) {
    console.log(`  - id=${r.id} seller.user_id=${r.seller_user_id} ${r.seller_doc_name} ${r.total_amount} ${r.currency}`);
  }

  // Run the bind (sends catch-up WhatsApp per row).
  const n = await bindPendingByPhone(user.id, user.phone);
  console.log(`\n✓ Bound ${n} row(s) to user.id=${user.id} and triggered catch-up WhatsApp.`);
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
