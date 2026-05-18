/**
 * Admin CLI for the unhandled_requests log — see what features users are
 * asking for that the bot can't handle yet.
 *
 * Usage:
 *   node scripts/unhandled.js                       # list pending (default)
 *   node scripts/unhandled.js list <status>         # list by status
 *   node scripts/unhandled.js show <id>             # full detail for one row
 *   node scripts/unhandled.js resolve <id> [note]   # mark resolved (built, not yet notified)
 *   node scripts/unhandled.js dismiss <id> [note]   # mark dismissed (not building)
 *   node scripts/unhandled.js notify <id>           # mark notified (after sending the user a message)
 *   node scripts/unhandled.js stats                 # counts per status + top users
 *
 * Status values: pending | resolved | notified | dismissed
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query } = require('../src/db');

function fmt(row) {
  return (
    `#${row.id}  [${row.status}]  user=${row.user_id} (${row.phone || '?'})  ${row.created_at?.slice(0, 19) || ''}\n` +
    `  message: ${row.message_text}\n` +
    (row.bot_reply ? `  bot:     ${row.bot_reply.slice(0, 140)}\n` : '') +
    (row.notes ? `  notes:   ${row.notes}\n` : '')
  );
}

async function list(status = 'pending') {
  const r = await query(
    `SELECT u.*, usr.phone
       FROM unhandled_requests u
       JOIN users usr ON usr.id = u.user_id
      WHERE u.status = $1
      ORDER BY u.created_at DESC
      LIMIT 100`,
    [status]
  );
  if (!r.rowCount) {
    console.log(`(no rows with status="${status}")`);
    return;
  }
  console.log(`${r.rowCount} unhandled request(s) [status=${status}]:\n`);
  for (const row of r.rows) console.log(fmt(row));
}

async function show(id) {
  const r = await query(
    `SELECT u.*, usr.phone
       FROM unhandled_requests u
       JOIN users usr ON usr.id = u.user_id
      WHERE u.id = $1`,
    [id]
  );
  if (!r.rowCount) {
    console.log(`(no row #${id})`);
    return;
  }
  const row = r.rows[0];
  console.log(`#${row.id}  [${row.status}]`);
  console.log(`User:        ${row.user_id} (${row.phone})`);
  console.log(`Created:     ${row.created_at}`);
  console.log(`Resolved:    ${row.resolved_at || '-'}`);
  console.log(`Notified:    ${row.notified_at || '-'}`);
  console.log(`Notes:       ${row.notes || '-'}`);
  console.log(`Message:`);
  console.log(`  ${row.message_text}`);
  console.log(`Bot reply:`);
  console.log(`  ${row.bot_reply || '-'}`);
}

async function setStatus(id, status, note, ts_field) {
  const now = new Date().toISOString();
  const fields = [`status = $1`, `notes = COALESCE($2, notes)`];
  const params = [status, note || null];
  if (ts_field) {
    fields.push(`${ts_field} = $${params.length + 1}`);
    params.push(now);
  }
  params.push(id);
  const sql = `UPDATE unhandled_requests SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`;
  const r = await query(sql, params);
  if (!r.rowCount) {
    console.log(`(no row #${id})`);
    return;
  }
  console.log(`#${id} → ${status}`);
}

async function stats() {
  const byStatus = await query(
    `SELECT status, COUNT(*)::int AS n FROM unhandled_requests GROUP BY status ORDER BY n DESC`
  );
  console.log('By status:');
  for (const row of byStatus.rows) {
    console.log(`  ${row.status.padEnd(10)} ${row.n}`);
  }
  console.log('');
  const topUsers = await query(
    `SELECT u.user_id, usr.phone, COUNT(*)::int AS n
       FROM unhandled_requests u
       JOIN users usr ON usr.id = u.user_id
      GROUP BY u.user_id, usr.phone
      ORDER BY n DESC LIMIT 10`
  );
  console.log('Top users (all-time):');
  for (const row of topUsers.rows) {
    console.log(`  user=${row.user_id} (${row.phone}) ${row.n}`);
  }
}

(async () => {
  const cmd = process.argv[2] || 'list';
  const arg = process.argv[3];
  const note = process.argv.slice(4).join(' ') || null;

  try {
    if (cmd === 'list') await list(arg || 'pending');
    else if (cmd === 'show') await show(parseInt(arg, 10));
    else if (cmd === 'resolve') await setStatus(parseInt(arg, 10), 'resolved', note, 'resolved_at');
    else if (cmd === 'dismiss') await setStatus(parseInt(arg, 10), 'dismissed', note, null);
    else if (cmd === 'notify') await setStatus(parseInt(arg, 10), 'notified', note, 'notified_at');
    else if (cmd === 'stats') await stats();
    else {
      console.log('Unknown command. See top of this file for usage.');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('error:', err.message);
    process.exit(1);
  }
})();
