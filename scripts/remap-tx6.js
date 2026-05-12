/**
 * One-off: Tx 6 was saved with payment_account_id=30 (KBank duplicate that's now soft-deleted).
 * Move it to point at id=29 (the active KBank), so the opening balance shows in queries.
 *
 * Safe to delete after running.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

(async () => {
  await init();

  const before = await query(
    'SELECT id, payment_account_id, amount, currency, description FROM transactions WHERE id = 6'
  );
  console.log('[remap-tx6] before:', before.rows[0] || '(no Tx 6 found)');

  if (before.rowCount === 0 || before.rows[0].payment_account_id !== 30) {
    console.log('[remap-tx6] no remap needed — Tx 6 not linked to id=30');
    process.exit(0);
  }

  const result = await query(
    `UPDATE transactions
     SET payment_account_id = 29, updated_at = $1
     WHERE id = 6 AND payment_account_id = 30`,
    [new Date().toISOString()]
  );

  const after = await query(
    'SELECT id, payment_account_id, amount, currency, description FROM transactions WHERE id = 6'
  );
  console.log('[remap-tx6] after:', after.rows[0]);
  console.log(`[remap-tx6] updated ${result.rowCount} row`);
  process.exit(0);
})().catch((err) => {
  console.error('[remap-tx6] error:', err);
  process.exit(1);
});
