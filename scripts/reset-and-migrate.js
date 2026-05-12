/**
 * DESTRUCTIVE — drops all existing tables in the bot's Postgres and recreates
 * the new post-pivot schema (ERPNext-backed). Then seeds the test user.
 *
 * Run when you want a clean slate. Will wipe ALL transactions, counterparties,
 * conversations, etc. ERPNext data is unaffected.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

(async () => {
  console.log('[reset] DROPPING all bot DB tables...');

  // Old (pre-pivot) tables + new tables — drop everything we might have created
  // CASCADE handles FK deps regardless of order
  const allTables = [
    // pre-pivot
    'transaction_line_items',
    'transaction_postings',
    'transactions',
    'chart_of_accounts',
    'counterparties',
    // shared lifetime
    'messages',
    'conversations',
    'users',
    // post-pivot
    'outbox',
    'counterparty_cache',
    'account_cache',
    'otp_attempts',
  ];

  for (const t of allTables) {
    await query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    console.log(`  dropped ${t}`);
  }

  console.log('\n[reset] running new schema migration...');
  await init();

  console.log('\n[reset] verifying tables...');
  const r = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
     ORDER BY table_name`
  );
  for (const row of r.rows) console.log(`  ✓ ${row.table_name}`);

  console.log('\n[reset] done — DB is on the new schema');
  process.exit(0);
})().catch((err) => {
  console.error('[reset] error:', err);
  process.exit(1);
});
