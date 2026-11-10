/**
 * Nightly cleanup of the public ERPNext Files that outreach uploads (invoice PDFs, PromptPay QRs).
 * They're public so Twilio can fetch them at send time; after FILE_TTL_DAYS nobody needs them and
 * the random-suffix URL is the only thing protecting a customer's invoice, so delete them.
 *
 * Runs for every user regardless of reminders_enabled — manual send_invoice uploads files too.
 * Called by src/jobs/scheduler.js at most once per user per day with deps = { erp, now, ... }.
 */
const { query } = require('../db');
const { ts } = require('../erp-sync/common');
const { RETENTION_DAYS } = require('../media/store');

const FILE_TTL_DAYS = 2;

/**
 * Receipt blobs are pruned when a new one is stored (src/media/store.js), which on a quiet
 * instance can leave one past the RETENTION_DAYS the privacy notice promises. The nightly job
 * enforces it for this user whether or not they upload anything.
 */
async function purgeReceipts(userId, now) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  const r = await query('DELETE FROM media_blobs WHERE user_id = $1 AND created_at < $2', [userId, cutoff]);
  return r.rowCount || 0;
}

async function run(user, deps = {}) {
  const { erp } = deps;
  const now = deps.now || new Date();
  const receipts = await purgeReceipts(user.id, now);
  const cutoff = new Date(now.getTime() - FILE_TTL_DAYS * 86400000).toISOString();
  const r = await query(
    `SELECT id, files FROM outreach_log WHERE user_id = $1 AND files IS NOT NULL AND sent_at < $2`,
    [user.id, cutoff]
  );
  if (!r.rows.length) {
    if (!receipts) return { skipped: true, note: 'nothing to clean' };
    console.log(`• [media] [${ts()}] cleanup user_id=${user.id} purged ${receipts} receipt(s)`);
    return { receipts, note: `purged ${receipts} receipt(s)` };
  }

  const done = new Set();
  let deleted = 0;
  let failed = 0;
  for (const row of r.rows) {
    let names = [];
    try {
      names = JSON.parse(row.files) || [];
    } catch {
      names = [];
    }
    let ok = true;
    for (const name of names) {
      if (done.has(name)) continue; // grouped sends log the same files on each invoice's row
      try {
        await erp.deleteResource('File', name);
        deleted++;
      } catch (err) {
        if (err.status !== 404) {
          ok = false;
          failed++;
          console.error(`• [outreach] [${ts()}] couldn't delete File ${name}: ${err.message}`);
          continue;
        }
      }
      done.add(name);
    }
    // Keep the names when a delete failed, so tomorrow's run tries again.
    if (ok) await query('UPDATE outreach_log SET files = NULL WHERE id = $1', [row.id]);
  }
  const note = `deleted ${deleted} file(s)${failed ? `, ${failed} failed` : ''}${receipts ? `, purged ${receipts} receipt(s)` : ''}`;
  console.log(`• [outreach] [${ts()}] cleanup user_id=${user.id} ${note}`);
  return { deleted, failed, receipts, note };
}

module.exports = { name: 'cleanup', defaultTime: '03:00', window: 180, run };
