/**
 * Standalone Postgres connectivity check. Bypasses the rest of the app —
 * just confirms we can reach Railway PG and run a trivial query.
 *
 * Usage: node scripts/ping-db.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[ping-db] DATABASE_URL is not set');
  process.exit(1);
}

const isInternal = url.includes('.railway.internal');

try {
  const u = new URL(url);
  console.log(`[ping-db] target: ${u.hostname}:${u.port || 5432} (ssl=${!isInternal})`);
} catch {}

const pool = new Pool({
  connectionString: url,
  ssl: isInternal ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 60000,
});

const started = Date.now();

(async () => {
  try {
    const r = await pool.query('SELECT NOW() AS now, current_database() AS db');
    const elapsed = Date.now() - started;
    console.log(`[ping-db] OK in ${elapsed}ms — db=${r.rows[0].db} now=${r.rows[0].now}`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    const elapsed = Date.now() - started;
    console.error(`[ping-db] FAILED after ${elapsed}ms: ${err.message}`);
    if (err.cause) console.error(`[ping-db] cause: ${err.cause.message || err.cause}`);
    process.exit(1);
  }
})();
