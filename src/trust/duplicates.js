/**
 * Duplicate guard: a fingerprint of every document the bot posted (trust_fingerprints, see
 * src/migrations/070-trust.sql), checked before each confirmation card.
 *   (a) the same receipt bytes (sha256) already posted by this user → hard warning
 *   (b) same amount + currency + counterparty within ±3 days        → soft warning
 * Warnings never block: the user confirming the card is the override.
 */
const crypto = require('crypto');
const { query } = require('../db');

const SIMILAR_WINDOW_DAYS = 3;
const RETENTION_DAYS = 180;

/** sha256 hex of a buffer (receipt photo / PDF bytes). */
function contentHash(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** "  ACME  Co. " → "acme co."; null for blank. */
function normalizeName(name) {
  const s = String(name == null ? '' : name).trim().replace(/\s+/g, ' ').toLowerCase();
  return s || null;
}

function addDays(iso, n) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The receipt's hash for a draft's receipt_media_id: the sha256 media intake stored, else hashed
 * from the bytes (a blob stored before 070-trust.sql). Null when there is no such blob for this user.
 */
async function receiptHash(userId, mediaId) {
  if (!userId || mediaId == null || mediaId === '') return null;
  const id = Number(mediaId);
  if (!Number.isInteger(id)) return null;
  const r = await query('SELECT sha256, bytes FROM media_blobs WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = r.rows[0];
  if (!row) return null;
  return row.sha256 || contentHash(row.bytes);
}

/**
 * Store a posted document's fingerprint. Opportunistically prunes rows past the retention window
 * that are no longer awaiting review (no cron needed; ISO strings compare correctly as TEXT).
 * @param {object} fp  { userId, doctype, erpnextName, direction, amount, currency, baseAmount,
 *                       transactionDate, counterpartyName, receiptHash, warnings }
 */
async function recordFingerprint(fp) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  await query("DELETE FROM trust_fingerprints WHERE created_at < $1 AND review_status <> 'pending'", [cutoff]);
  const r = await query(
    `INSERT INTO trust_fingerprints
       (user_id, doctype, erpnext_name, direction, amount, currency, base_amount, transaction_date,
        counterparty_name, receipt_hash, warnings, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [fp.userId, fp.doctype, fp.erpnextName, fp.direction || null,
      fp.amount == null ? null : Number(fp.amount), fp.currency || null,
      fp.baseAmount == null ? null : Number(fp.baseAmount), fp.transactionDate || null,
      normalizeName(fp.counterpartyName), fp.receiptHash || null,
      fp.warnings && fp.warnings.length ? JSON.stringify(fp.warnings) : null, now.toISOString()]
  );
  return r.rows[0];
}

/**
 * Earlier postings this draft may duplicate. `direction` / `settles` (the draft's parent_invoice_name)
 * narrow the "similar" match; the same-receipt match ignores them.
 * @returns {Promise<{ sameReceipt: object|null, similar: object|null }>} the most recent match of each kind
 */
async function findDuplicates(userId, { amount, currency, transactionDate, counterpartyName, receiptHash: hash, direction = null, settles = null }) {
  let sameReceipt = null;
  if (hash) {
    const r = await query(
      'SELECT * FROM trust_fingerprints WHERE user_id = $1 AND receipt_hash = $2 ORDER BY id DESC LIMIT 1',
      [userId, hash]
    );
    sameReceipt = r.rows[0] || null;
  }
  // Similar needs a counterparty: "185 THB, no counterparty" twice in 3 days is normal (coffee).
  let similar = null;
  const cp = normalizeName(counterpartyName);
  if (cp && Number(amount) > 0 && currency && transactionDate) {
    const r = await query(
      `SELECT * FROM trust_fingerprints
       WHERE user_id = $1 AND counterparty_name = $2 AND currency = $3
         AND transaction_date >= $4 AND transaction_date <= $5
       ORDER BY id DESC`,
      [userId, cp, currency, addDays(transactionDate, -SIMILAR_WINDOW_DAYS), addDays(transactionDate, SIMILAR_WINDOW_DAYS)]
    );
    // Amount compared in JS: NUMERIC comes back as a string, and 1500 must equal 1500.00.
    // Same direction only (money back from a supplier isn't a second payment to them), and never
    // the document this draft settles: paying invoice X naturally matches X's amount and party.
    similar = r.rows.find((row) => Math.abs(Number(row.amount) - Number(amount)) < 0.005
      && !(sameReceipt && row.id === sameReceipt.id)
      && !(direction && row.direction && row.direction !== direction)
      && !(settles && row.erpnext_name === settles)) || null;
  }
  return { sameReceipt, similar };
}

/** Median of the base (reporting-currency) amounts the user posted per direction since `sinceDate`. */
async function medianByDirection(userId, sinceDate) {
  const r = await query(
    `SELECT direction, base_amount FROM trust_fingerprints
     WHERE user_id = $1 AND transaction_date >= $2 AND base_amount IS NOT NULL`,
    [userId, sinceDate]
  );
  const by = {};
  for (const row of r.rows) (by[row.direction] = by[row.direction] || []).push(Number(row.base_amount));
  const out = {};
  for (const [dir, xs] of Object.entries(by)) {
    xs.sort((a, b) => a - b);
    const m = xs.length >> 1;
    out[dir] = { median: xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2, count: xs.length };
  }
  return out;
}

/** True if the user has posted anything with this counterparty before. */
async function hasPostedTo(userId, counterpartyName) {
  const cp = normalizeName(counterpartyName);
  if (!cp) return false;
  const r = await query('SELECT id FROM trust_fingerprints WHERE user_id = $1 AND counterparty_name = $2 LIMIT 1', [userId, cp]);
  return r.rows.length > 0;
}

module.exports = {
  contentHash, normalizeName, receiptHash, recordFingerprint, findDuplicates, medianByDirection, hasPostedTo,
  addDays, SIMILAR_WINDOW_DAYS, RETENTION_DAYS,
};
