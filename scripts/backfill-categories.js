/**
 * Backfill category_code on Tx 4, 5, 6 (LLM didn't set it before strengthened prompt).
 * Restore Tx 7 to its actual recorded values (1400 USD, rate 32.545) and link to a USD Cash wallet.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

const userId = 1;
const now = new Date().toISOString();

async function ensureWallet(name, parentCode, currency) {
  const existing = await query(
    `SELECT id FROM chart_of_accounts
     WHERE user_id = $1 AND parent_code = $2 AND currency = $3 AND LOWER(name) = LOWER($4) AND is_active = 1`,
    [userId, parentCode, currency, name]
  );
  if (existing.rowCount > 0) return existing.rows[0].id;

  const seqRes = await query(
    `SELECT COUNT(*)::int AS n FROM chart_of_accounts WHERE user_id = $1 AND parent_code = $2`,
    [userId, parentCode]
  );
  const code = `${parentCode}-${String(seqRes.rows[0].n + 1).padStart(3, '0')}`;
  const ins = await query(
    `INSERT INTO chart_of_accounts (user_id, code, name, type, parent_code, currency, is_active, created_at)
     VALUES ($1, $2, $3, 'asset', $4, $5, 1, $6) RETURNING id`,
    [userId, code, name, parentCode, currency, now]
  );
  return ins.rows[0].id;
}

(async () => {
  await init();

  // Tx 4 + 5: invoice sales → category 4000 Sales Revenue
  for (const id of [4, 5]) {
    const r = await query(
      `UPDATE transactions SET category_code = '4000', updated_at = $1 WHERE id = $2 AND category_code IS NULL`,
      [now, id]
    );
    console.log(`[backfill] Tx ${id} → category_code=4000 (rows ${r.rowCount})`);
  }

  // Tx 6: opening balance → category 3200 Opening Balance Equity
  const r6 = await query(
    `UPDATE transactions SET category_code = '3200', updated_at = $1 WHERE id = 6 AND category_code IS NULL`,
    [now]
  );
  console.log(`[backfill] Tx 6 → category_code=3200 (rows ${r6.rowCount})`);

  // Ensure a "Cash" USD wallet exists
  const usdCashId = await ensureWallet('Cash', '1000', 'USD');
  console.log(`[backfill] USD Cash wallet id=${usdCashId}`);

  // Restore Tx 7: original was 1400 USD with rate 32.545. Currently stored as 45563 THB.
  const tx7Before = await query('SELECT id, amount, currency, payment_account_id, category_code FROM transactions WHERE id = 7');
  console.log('[backfill] Tx 7 before:', tx7Before.rows[0]);

  const r7 = await query(
    `UPDATE transactions
     SET amount = 1400, currency = 'USD',
         category_code = '4000',
         payment_account_id = $1,
         updated_at = $2
     WHERE id = 7`,
    [usdCashId, now]
  );
  console.log(`[backfill] Tx 7 restored to 1400 USD, linked to wallet ${usdCashId} (rows ${r7.rowCount})`);

  // Update Tx 7's posting to reflect base_amount + rate
  const baseAmount = 1400 * 32.545;
  const rp7 = await query(
    `UPDATE transaction_postings
     SET base_amount = $1, base_currency = 'THB', exchange_rate = 32.545, exchange_rate_source = 'frankfurter',
         status = 'pending', updated_at = $2
     WHERE transaction_id = 7`,
    [baseAmount, now]
  );
  console.log(`[backfill] Tx 7 posting → base_amount=${baseAmount} (rows ${rp7.rowCount})`);

  const tx7After = await query('SELECT id, amount, currency, payment_account_id, category_code FROM transactions WHERE id = 7');
  console.log('[backfill] Tx 7 after:', tx7After.rows[0]);

  console.log('\n[backfill] done');
  process.exit(0);
})().catch((err) => {
  console.error('[backfill] error:', err);
  process.exit(1);
});
