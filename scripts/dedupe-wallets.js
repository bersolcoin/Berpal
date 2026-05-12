/**
 * One-off: find duplicate user wallets (same user_id + parent_code + currency + name),
 * soft-delete (is_active=0) the ones with NO transactions linked.
 *
 * Safe to run repeatedly — only touches duplicates with zero references.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

(async () => {
  await init();

  // Find all duplicate groups
  const groups = await query(
    `SELECT user_id, parent_code, currency, LOWER(name) AS lname, COUNT(*) AS cnt
     FROM chart_of_accounts
     WHERE user_id IS NOT NULL AND is_active = 1
     GROUP BY user_id, parent_code, currency, LOWER(name)
     HAVING COUNT(*) > 1`
  );

  if (groups.rowCount === 0) {
    console.log('[dedupe] no duplicate wallets found');
    process.exit(0);
  }

  console.log(`[dedupe] found ${groups.rowCount} duplicate group(s)`);

  for (const g of groups.rows) {
    const dupes = await query(
      `SELECT coa.id, coa.code, coa.name, coa.created_at,
              COUNT(tx.id)::int AS tx_count
       FROM chart_of_accounts coa
       LEFT JOIN transactions tx
         ON tx.payment_account_id = coa.id
         OR tx.transfer_destination_account_id = coa.id
       WHERE coa.user_id = $1
         AND coa.parent_code = $2
         AND coa.currency = $3
         AND LOWER(coa.name) = $4
         AND coa.is_active = 1
       GROUP BY coa.id, coa.code, coa.name, coa.created_at
       ORDER BY tx_count DESC, coa.id ASC`,
      [g.user_id, g.parent_code, g.currency, g.lname]
    );

    console.log(`\n[dedupe] group: user=${g.user_id} ${g.parent_code} ${g.currency} "${g.lname}"`);
    for (const d of dupes.rows) {
      console.log(`  id=${d.id} code=${d.code} name="${d.name}" tx_count=${d.tx_count} created=${d.created_at}`);
    }

    // Keep the one with the most transactions (or, if tie, the lowest id).
    // Soft-delete the rest IF they have zero transactions.
    const [keeper, ...rest] = dupes.rows;
    console.log(`  → keep id=${keeper.id} (tx_count=${keeper.tx_count})`);

    for (const d of rest) {
      if (d.tx_count > 0) {
        console.log(`  → SKIP id=${d.id} — has ${d.tx_count} transactions, not safe to delete`);
        continue;
      }
      await query(
        `UPDATE chart_of_accounts SET is_active = 0 WHERE id = $1`,
        [d.id]
      );
      console.log(`  → soft-deleted id=${d.id} (is_active=0)`);
    }
  }

  console.log('\n[dedupe] done');
  process.exit(0);
})().catch((err) => {
  console.error('[dedupe] error:', err);
  process.exit(1);
});
