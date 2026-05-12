/**
 * Run pending DB migrations (idempotent). Safe to run any time.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { init } = require('../src/db');

(async () => {
  await init();
  process.exit(0);
})().catch((err) => {
  console.error('[migrate] error:', err);
  process.exit(1);
});
