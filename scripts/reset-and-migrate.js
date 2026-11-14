/**
 * DESTRUCTIVE — drops all existing tables in the bot's Postgres and recreates
 * the new post-pivot schema (ERPNext-backed). Then seeds the test user
 * (skip with --no-seed).
 *
 * Run when you want a clean slate. Will wipe ALL transactions, counterparties,
 * conversations, etc. ERPNext data is unaffected.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');

(async () => {
  console.log('[reset] DROPPING all bot DB tables...');

  // Drop every table in the public schema — no hand-kept list to drift
  // out of date as the schema grows. CASCADE handles FK deps.
  const existing = await query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  for (const { tablename } of existing.rows) {
    await query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
    console.log(`  dropped ${tablename}`);
  }

  // --no-seed: skip the SEED_TEST_USER_PHONE user. That seed maps to the
  // base Company with the admin API keys — a hand-made tenant that bypasses
  // /onboarding (and the tenant fence). Use it for a truly clean slate.
  if (process.argv.includes('--no-seed')) delete process.env.SEED_TEST_USER_PHONE;

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
