/**
 * Accountant review status for bot-posted documents.
 *   markPosted     → after save_transaction: store the fingerprint (review_status 'pending') and add
 *                    a Comment on the ERPNext document — stock v14 supports Comments on any doctype,
 *                    so no custom field is needed.
 *   listPending    → the local queue of documents still awaiting review (Postgres only).
 *   pendingSummary → count / oldest / stale, for the morning digest.
 *   markReviewed   → the owner (from chat) closes queue rows; a second Comment records who and when.
 * Neither the fingerprint nor a Comment may fail the save or the review: the document is already
 * posted, and a review is a local status first.
 */
const { query } = require('../db');
const { ts } = require('../erp-sync/common');
const duplicates = require('./duplicates');
const { fingerprintFields } = require('./index');

const REVIEW_NOTE = 'Berpal: posted from WhatsApp, awaiting accountant review';
const STALE_REVIEW_DAYS = 14;
const MAX_NAMES = 50;
const MAX_NOTE_CHARS = 300;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Comment content is HTML in ERPNext: escape the lines and break with <br> (a bare \n collapses). */
function htmlLines(lines) {
  return lines.filter(Boolean).map(escapeHtml).join('<br>');
}

function commentText(warnings) {
  const list = (warnings || []).filter(Boolean);
  return list.length
    ? htmlLines([REVIEW_NOTE, 'Warnings shown to the user:', ...list.map((w) => `- ${w}`)])
    : REVIEW_NOTE;
}

/** The Comment closing the review: who, when (date only), and the owner's note if any. */
function reviewedCommentText(reviewer, isoNow, note) {
  return htmlLines([`Berpal: reviewed by ${reviewer} on ${String(isoNow).slice(0, 10)}`, note ? `Note: ${note}` : null]);
}

/**
 * @param {object} erp  per-user ErpNextClient (null → local row only)
 * @param {{ user, saved: { doctype, erpnext_name }, draft, mediaId? }} args
 *   draft is the draft as confirmed (read before saveDraft cleared it); its trust_warnings are the
 *   lines the card showed. Call before attachToDoc: the receipt blob is deleted once attached.
 * @returns {Promise<{ fingerprint: object|null, comment: object|null }>}
 */
async function markPosted(erp, { user, saved, draft, mediaId = null }) {
  const warnings = Array.isArray(draft.trust_warnings) ? draft.trust_warnings : [];
  let fingerprint = null;
  try {
    const f = await fingerprintFields(user, draft);
    // Re-hash from the blob when we still have it: draft.receipt_hash passed through the model.
    const hash = (mediaId != null ? await duplicates.receiptHash(user.id, mediaId) : null) || draft.receipt_hash || null;
    fingerprint = await duplicates.recordFingerprint({
      userId: user.id, doctype: saved.doctype, erpnextName: saved.erpnext_name, direction: draft.direction,
      amount: f.amount, currency: f.currency, baseAmount: f.baseAmount, transactionDate: f.transactionDate,
      counterpartyName: f.counterpartyName, receiptHash: hash, warnings,
    });
  } catch (err) {
    console.error(`[trust] fingerprint failed (${saved.doctype} ${saved.erpnext_name}):`, err.message);
  }

  let comment = null;
  if (erp) {
    try {
      const r = await erp.createResource('Comment', {
        comment_type: 'Comment',
        reference_doctype: saved.doctype,
        reference_name: saved.erpnext_name,
        content: commentText(warnings),
      });
      comment = (r && r.data) || r || null;
      console.log(`• [trust] [${ts()}] review comment on ${saved.doctype} ${saved.erpnext_name}`);
    } catch (err) {
      console.error(`[trust] review comment failed (${saved.doctype} ${saved.erpnext_name}):`, err.message);
    }
  }
  return { fingerprint, comment };
}

const isoDaysAgo = (now, days) => new Date(now.getTime() - days * 86400000).toISOString();
// The only value interpolated into SQL: always a finite integer in [1, MAX_PAGE] (JSON.parse('1e999') is Infinity).
const MAX_PAGE = 500;
const pageSize = (limit) => {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PAGE) : 30;
};

function rowOut(row) {
  return {
    ...row,
    amount: row.amount == null ? null : Number(row.amount),
    warnings: row.warnings ? JSON.parse(row.warnings) : [],
  };
}

/**
 * Documents this user's bot posted that no accountant has reviewed yet, oldest first (by
 * transaction date, then posting order). `olderThanDays` keeps only rows pending at least that
 * long (by created_at — "pending for N days", not the document's date).
 * @returns {Promise<{ total: number, rows: object[] }>}  total is the whole queue, not the page
 */
async function listPending(userId, { limit = 30, olderThanDays = null, now = new Date() } = {}) {
  if (!userId) throw new Error('listPending: userId is required');
  const where = ["user_id = $1", "review_status = 'pending'"];
  const params = [userId];
  if (olderThanDays != null) {
    params.push(isoDaysAgo(now, Number(olderThanDays)));
    where.push(`created_at <= $${params.length}`);
  }
  const count = await query(`SELECT COUNT(*) AS n FROM trust_fingerprints WHERE ${where.join(' AND ')}`, params);
  const r = await query(
    `SELECT id, doctype, erpnext_name, direction, amount, currency, transaction_date, counterparty_name, warnings, created_at
     FROM trust_fingerprints WHERE ${where.join(' AND ')} ORDER BY transaction_date, id LIMIT ${pageSize(limit)}`,
    params
  );
  return { total: Number(count.rows[0].n), rows: r.rows.map(rowOut) };
}

/**
 * For the digest: how many await review, the oldest document date, and how many have sat in the
 * queue longer than STALE_REVIEW_DAYS.
 * @returns {Promise<{ count: number, oldest: string|null, stale: number }>}
 */
async function pendingSummary(userId, { now = new Date() } = {}) {
  if (!userId) throw new Error('pendingSummary: userId is required');
  const r = await query(
    "SELECT transaction_date, created_at FROM trust_fingerprints WHERE user_id = $1 AND review_status = 'pending'",
    [userId]
  );
  const staleBefore = isoDaysAgo(now, STALE_REVIEW_DAYS);
  let oldest = null;
  let stale = 0;
  for (const row of r.rows) {
    const d = row.transaction_date || String(row.created_at).slice(0, 10);
    if (oldest == null || d < oldest) oldest = d;
    if (row.created_at < staleBefore) stale++;
  }
  return { count: r.rows.length, oldest, stale };
}

const normName = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * Close queue rows as reviewed, from chat. Either `names` (ERPNext names, case-insensitive) or
 * `all` with `expectedCount`: "mark all" only acts when the queue still has exactly the rows the
 * user was shown, otherwise the caller re-lists. The DB update is the review; the per-document
 * ERPNext Comment is best effort and never undoes it.
 * @param {object|null} erp  per-user ErpNextClient (null → no Comments)
 * @param {{ user, names?: string[], all?: boolean, expectedCount?: number, note?: string, reviewer: string }} args
 *   reviewer is a channel label built by the caller ('owner via whatsapp'), never a raw address.
 * @returns {Promise<{ ok: true, marked: {erpnext_name, doctype}[], already_reviewed: string[], not_found: string[], comment_failures: number, pending_after: number }
 *                  | { ok: false, reason: 'count_changed', pending: number, error: string }>}
 */
async function markReviewed(erp, { user, names = null, all = false, expectedCount = null, note = null, reviewer }) {
  if (!user || !user.id) throw new Error('markReviewed: user is required');
  if (!reviewer) throw new Error('markReviewed: reviewer is required');
  const cleanNote = note == null ? null : String(note).trim().slice(0, MAX_NOTE_CHARS) || null;
  const nowIso = new Date().toISOString();

  let toMark = [];
  const alreadyReviewed = [];
  const notFound = [];
  if (all) {
    const pending = await query(
      "SELECT id, doctype, erpnext_name FROM trust_fingerprints WHERE user_id = $1 AND review_status = 'pending' ORDER BY id",
      [user.id]
    );
    if (Number(expectedCount) !== pending.rows.length) {
      // `error` is what the model reads; `pending` is the new total it should confirm with the user.
      return {
        ok: false, reason: 'count_changed', pending: pending.rows.length,
        error: `The queue changed since it was listed: ${pending.rows.length} pending now. List it again and ask before marking all.`,
      };
    }
    toMark = pending.rows;
  } else {
    const wanted = [...new Set((names || []).map(normName).filter(Boolean))].slice(0, MAX_NAMES);
    if (!wanted.length) return { ok: true, marked: [], already_reviewed: [], not_found: [], comment_failures: 0 };
    // Matched in JS: the names are few and LOWER(TRIM()) on the column would skip the index.
    const rows = await query(
      'SELECT id, doctype, erpnext_name, review_status FROM trust_fingerprints WHERE user_id = $1 ORDER BY id',
      [user.id]
    );
    // One row per name; when this user has the same name twice (a re-post across doctypes), the
    // pending one wins, else the first — a stale reviewed twin must not hide the one still queued.
    const byName = new Map();
    for (const row of rows.rows) {
      const key = normName(row.erpnext_name);
      const cur = byName.get(key);
      if (!cur || (cur.review_status !== 'pending' && row.review_status === 'pending')) byName.set(key, row);
    }
    for (const n of wanted) {
      const row = byName.get(n);
      if (!row) notFound.push(n);
      else if (row.review_status !== 'pending') alreadyReviewed.push(row.erpnext_name);
      else toMark.push(row);
    }
  }

  if (toMark.length) {
    // One placeholder per id (not `= ANY($n::int[])`): pg-mem, which the tests run on, matches
    // nothing for an array parameter in an UPDATE. Postgres takes tens of thousands of placeholders.
    const ids = toMark.map((r, i) => `$${i + 5}`).join(', ');
    await query(
      `UPDATE trust_fingerprints SET review_status = 'reviewed', reviewed_at = $2, reviewed_by = $3, review_note = $4
       WHERE user_id = $1 AND review_status = 'pending' AND id IN (${ids})`,
      [user.id, nowIso, reviewer, cleanNote, ...toMark.map((r) => r.id)]
    );
  }
  const marked = toMark.map((r) => ({ erpnext_name: r.erpnext_name, doctype: r.doctype }));

  // Sequential so a slow ERPNext doesn't get a burst of 50 POSTs; a failure costs only the Comment.
  let commentFailures = 0;
  if (erp) {
    for (const m of marked) {
      try {
        await erp.createResource('Comment', {
          comment_type: 'Comment',
          reference_doctype: m.doctype,
          reference_name: m.erpnext_name,
          content: reviewedCommentText(reviewer, nowIso, cleanNote),
        });
      } catch (err) {
        commentFailures++;
        console.error(`[trust] reviewed comment failed (${m.doctype} ${m.erpnext_name}):`, err.message);
      }
    }
    console.log(`• [trust] [${ts()}] marked ${marked.length} reviewed by ${reviewer}${commentFailures ? ` (${commentFailures} comment failures)` : ''}`);
  }
  // pending_after: the queue total now, so a following "all reviewed" can pass the right expected count
  // without listing again (the user has already seen every remaining row).
  const left = await query("SELECT COUNT(*) AS n FROM trust_fingerprints WHERE user_id = $1 AND review_status = 'pending'", [user.id]);
  return {
    ok: true, marked, already_reviewed: alreadyReviewed, not_found: notFound, comment_failures: commentFailures,
    pending_after: Number(left.rows[0].n),
  };
}

module.exports = {
  markPosted, listPending, pendingSummary, markReviewed, commentText, reviewedCommentText,
  REVIEW_NOTE, STALE_REVIEW_DAYS, MAX_NAMES, MAX_NOTE_CHARS,
};
