/**
 * Read-only — print all transactions for user 1 so we can see what's actually in the DB.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

(async () => {
  await init();

  const result = await query(
    `SELECT tx.id, tx.transaction_type, tx.transaction_date, tx.direction,
            tx.amount, tx.currency, tx.payment_status,
            tx.payment_account_id, tx.category_code,
            cp.name AS counterparty,
            tx.description
     FROM transactions tx
     LEFT JOIN counterparties cp ON cp.id = tx.counterparty_id
     WHERE tx.created_by_user_id = 1
     ORDER BY tx.id`
  );

  console.log('All transactions for user 1:');
  for (const r of result.rows) {
    console.log(JSON.stringify(r));
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
