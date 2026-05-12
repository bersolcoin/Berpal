/**
 * One-off backfill: Tx 4 was saved before the LLM was reliably setting transaction_type.
 * It went in as default 'cash' with NULL payment_status, so query_open_invoices skips it.
 * Update it to invoice_issued / unpaid so it surfaces in receivables.
 *
 * Safe to delete this file after running once.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

(async () => {
  await init();

  const before = await query('SELECT id, transaction_type, payment_status, due_date FROM transactions WHERE id = 4');
  console.log('[fix-tx4] before:', before.rows[0] || '(no Tx 4 found)');

  if (before.rowCount === 0) {
    console.log('[fix-tx4] no Tx 4 in DB — nothing to do');
    process.exit(0);
  }

  const result = await query(
    `UPDATE transactions
     SET transaction_type = 'invoice_issued',
         payment_status = 'unpaid',
         due_date = '2026-08-01',
         updated_at = $1
     WHERE id = 4`,
    [new Date().toISOString()]
  );

  const after = await query('SELECT id, transaction_type, payment_status, due_date FROM transactions WHERE id = 4');
  console.log('[fix-tx4] after:', after.rows[0]);
  console.log(`[fix-tx4] updated ${result.rowCount} row`);
  process.exit(0);
})().catch((err) => {
  console.error('[fix-tx4] error:', err);
  process.exit(1);
});
