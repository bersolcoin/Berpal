/**
 * Show coa_cache size + a peek at the JSON for one or all users.
 *
 *   node scripts/inspect-coa-cache.js              # summary for everyone
 *   node scripts/inspect-coa-cache.js --user 1     # full row for users.id=1
 *   node scripts/inspect-coa-cache.js --user 1 --dump  # write JSON to disk
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { query, init } = require('../src/db');

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

(async () => {
  await init();

  const args = process.argv.slice(2);
  let onlyId = null;
  let dump = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') onlyId = parseInt(args[i + 1], 10);
    if (args[i] === '--dump') dump = true;
  }

  const r = await query(
    `SELECT c.user_id, c.updated_at,
            LENGTH(c.data) AS bytes,
            c.data,
            u.phone, u.erpnext_company
       FROM coa_cache c
       JOIN users u ON u.id = c.user_id
       ${onlyId ? 'WHERE c.user_id = $1' : ''}
       ORDER BY c.user_id`,
    onlyId ? [onlyId] : []
  );

  if (!r.rowCount) {
    console.log('No coa_cache rows.');
    process.exit(0);
  }

  for (const row of r.rows) {
    let parsed = [];
    try { parsed = JSON.parse(row.data); } catch { /* */ }
    console.log(
      `user.id=${row.user_id}  ${row.phone}  (${row.erpnext_company})\n` +
      `  size:    ${fmtBytes(row.bytes)}  (${row.bytes} bytes)\n` +
      `  rows:    ${parsed.length} accounts\n` +
      `  updated: ${row.updated_at}`
    );

    if (onlyId) {
      console.log('\n  first 5 accounts:');
      for (const a of parsed.slice(0, 5)) {
        console.log(
          `    - ${a.account_number || '   '}  ${a.account_name}` +
          `  [${a.account_type || a.root_type}]  ${a.account_currency || ''}` +
          `  ${a.is_group ? '(group)' : ''}`
        );
      }
      if (parsed.length > 5) console.log(`    … +${parsed.length - 5} more`);

      if (dump) {
        const out = path.join(__dirname, '..', `coa-cache-${row.user_id}.json`);
        fs.writeFileSync(out, JSON.stringify(parsed, null, 2));
        console.log(`\n  dumped → ${out}`);
      }
    }
    console.log('');
  }
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
