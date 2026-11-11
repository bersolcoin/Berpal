/**
 * Accountant review status for bot-posted documents.
 *   markPosted     → after save_transaction: store the fingerprint (review_status 'pending') and add
 *                    a Comment on the ERPNext document — stock v14 supports Comments on any doctype,
 *                    so no custom field is needed.
 *   markStockPosted → the same for a Stock Entry of a gem lot operation (src/lots), with a Comment
 *                    that says in plain words what the operation did, or that it was taken back.
 *   markCancelled  → a money document (a fee bill, a fee entry) that an undo of a lot operation
 *                    cancelled: out of the queue and out of the duplicate guard, with a Comment.
 *   listPending    → the local queue of documents still awaiting review (Postgres only).
 *   pendingSummary → count / oldest / stale, for the morning digest.
 *   markReviewed   → the owner (from chat) closes queue rows; a second Comment records who and when.
 * Neither the fingerprint nor a Comment may fail the save or the review: the document is already
 * posted, and a review is a local status first.
 */
const { query } = require('../db');
const { ts, round2, companyCurrency } = require('../erp-sync/common');
const lots = require('../lots');
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

const UNDO_NOTE = 'Berpal: taken back from WhatsApp (undo)';
const STOCK_DIRECTION = 'stock'; // trust_fingerprints.direction of a Stock Entry: never 'income' / 'expense'

const ct = (n) => Number(lots.round3(n)).toLocaleString('en-US', { maximumFractionDigits: 3 });
const amt = (n) => Number(round2(n)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const PLACE_WORDS = { work: 'out for work', memo: 'out on memo' };
const sum = (list) => round2((list || []).reduce((a, x) => a + (Number(x.cost) || 0), 0));

/** What the trader would call the operation ("cutting", "split"). Required late: lots/undo.js pulls in the card helpers. */
function opWords(o) {
  try {
    return require('../lots/undo').kindWords(o); // eslint-disable-line global-require
  } catch (err) {
    return String((o && (o.job || o.kind)) || 'stock operation');
  }
}

/** What a lot operation did, as the lines of the Comment on its stock entry. */
function stockCommentLines(op, { reference, currency, warnings }) {
  const lines = [REVIEW_NOTE, `Stock operation: ${opWords(op)}, ${op.date || ''} (Berpal ref ${reference})`];
  const inputs = op.inputs || [];
  const outputs = op.outputs || [];
  if (inputs.length) {
    lines.push('Lots in:', ...inputs.map((i) => {
      const part = i.whole ? `${ct(i.carats)} ct (the whole lot)` : `${ct(i.carats)} ct${i.before && i.before.carats != null ? ` of ${ct(i.before.carats)} ct` : ''}`;
      return `- ${i.code}: ${part}${i.pieces != null ? `, ${i.pieces} pcs` : ''}, cost ${amt(i.cost)} ${currency}`;
    }));
  }
  if (outputs.length) {
    lines.push('Lots out:', ...outputs.map((o) => {
      const where = PLACE_WORDS[o.to] ? `, ${PLACE_WORDS[o.to]}` : '';
      return `- ${o.code}: ${ct(o.carats)} ct${o.pieces != null ? `, ${o.pieces} pcs` : ''}, cost ${amt(o.cost)} ${currency}${o.new ? ' (new lot)' : ''}${where}`;
    }));
  }
  if (op.fee && Number(op.fee.amount) > 0) {
    const all = Math.abs(Number(op.fee.capitalised) - Number(op.fee.amount)) < 0.005;
    lines.push(all
      ? `Fee: ${amt(op.fee.amount)} ${currency}, included in the cost of the stones`
      : `Fee: ${amt(op.fee.amount)} ${currency}, of which ${amt(op.fee.capitalised || 0)} ${currency} went into the cost of the stones`);
  }
  const loss = Number(op.loss_carats) || 0;
  if (op.yield_pct != null) lines.push(`Yield: ${op.yield_pct}%${loss > 0 ? ` (${ct(loss)} ct lost)` : ''}`);
  else if (loss > 0) lines.push(`Weight lost: ${ct(loss)} ct`);
  if (op.holder) {
    lines.push(`With: ${op.holder}${op.due_date ? `, due ${op.due_date}` : ''}${op.memo_price_per_ct != null ? `, memo price ${amt(op.memo_price_per_ct)} per ct` : ''}`);
  }
  if (op.reason) lines.push(`Reason: ${op.reason}`);
  if (op.note) lines.push(`Note: ${op.note}`);
  if (warnings.length) lines.push('Warnings shown to the user:', ...warnings.map((w) => `- ${w}`));
  return lines;
}

/** The Comment on a stock entry whose operation was taken back (`op` is the undo plan of lots/undo.js). */
function undoCommentLines(op, { reference, currency, isoNow }) {
  const t = op.target || {};
  const lines = [
    UNDO_NOTE,
    `Taken back on ${String(isoNow).slice(0, 10)}: ${opWords(t)}${t.date ? ` of ${t.date}` : ''} (Berpal ref ${reference}). This stock entry is cancelled.`,
  ];
  const after = op.lots || [];
  const removed = op.removed || [];
  if (after.length || removed.length) {
    lines.push('The lots afterwards:', ...after.map((l) => `- ${l.code}: ${ct(l.carats)} ct, cost ${amt(l.cost)} ${currency}`));
    if (removed.length) lines.push(`- ${removed.join(', ')}: removed`);
  }
  return lines;
}

async function fingerprintOf(userId, doc) {
  const r = await query(
    'SELECT * FROM trust_fingerprints WHERE user_id = $1 AND doctype = $2 AND erpnext_name = $3 ORDER BY id DESC LIMIT 1',
    [userId, doc.doctype, doc.erpnext_name]
  );
  return r.rows[0] || null;
}

/**
 * A stock entry of a gem lot operation (src/lots/gate.js calls this once per Stock Entry, after
 * the operation is saved or taken back): into the accountant's queue like a money document,
 * since a sort by value or a cutting fee re-prices stock. Never throws.
 *   saved      → a 'pending' fingerprint (direction 'stock', the cost of the stones moved, no
 *                counterparty and no base amount: it stays out of the duplicate and anomaly
 *                checks) and a Comment saying what the operation did.
 *   taken back → a Comment on the (now cancelled) stock entry; its queue row, if still pending,
 *                stays in the queue with a line saying so. A cancelled entry is still the
 *                accountant's to see.
 * @param {object} erp  per-user ErpNextClient (null → local row only)
 * @param {{ user, doc: { doctype, erpnext_name }, op: object, undoing: boolean, reference: string, warnings: string[] }} args
 *   op is the ResolvedOp (src/lots/index.js), or the undo plan when undoing.
 * @returns {Promise<{ fingerprint: object|null, comment: object|null }>}
 */
async function markStockPosted(erp, { user, doc, op, undoing = false, reference, warnings = [] }) {
  // A money document that an undo cancelled is not a stock entry: it leaves the queue instead.
  if (undoing && doc && doc.doctype !== 'Stock Entry') return markCancelled(erp, { user, doc, op, reference });
  let fingerprint = null;
  let comment = null;
  let lines = null;
  try {
    const plan = op || {};
    const currency = companyCurrency(user);
    const shown = [...new Set([...(Array.isArray(plan.warnings) ? plan.warnings : []), ...(Array.isArray(warnings) ? warnings : [])].filter(Boolean).map(String))];
    const isoNow = new Date().toISOString();
    lines = undoing
      ? undoCommentLines(plan, { reference, currency, isoNow })
      : stockCommentLines(plan, { reference, currency, warnings: shown });
    try {
      const had = await fingerprintOf(user.id, doc);
      if (undoing) {
        fingerprint = had;
        if (had && had.review_status === 'pending') {
          const note = `Taken back on ${isoNow.slice(0, 10)} (undo): the stock entry is cancelled`;
          const list = had.warnings ? JSON.parse(had.warnings) : [];
          if (!list.some((w) => /^Taken back on /.test(w))) {
            const r = await query('UPDATE trust_fingerprints SET warnings = $2 WHERE id = $1 RETURNING *', [had.id, JSON.stringify([...list, note])]);
            fingerprint = r.rows[0] || had;
          } else {
            lines = null; // said once: a retry that finishes the undo does not comment again
          }
        }
      } else {
        // A second call for the same entry (a retry that finishes an operation) adds no second row.
        fingerprint = had || await duplicates.recordFingerprint({
          userId: user.id, doctype: doc.doctype, erpnextName: doc.erpnext_name, direction: STOCK_DIRECTION,
          amount: (plan.outputs || []).length ? sum(plan.outputs) : sum(plan.inputs), currency, baseAmount: null,
          transactionDate: plan.date || null, counterpartyName: null, receiptHash: null, warnings: shown,
        });
        if (had) lines = null; // commented on the first time
      }
    } catch (err) {
      console.error(`[trust] fingerprint failed (${doc.doctype} ${doc.erpnext_name}):`, err.message);
    }

    if (erp && lines) {
      try {
        const r = await erp.createResource('Comment', {
          comment_type: 'Comment',
          reference_doctype: doc.doctype,
          reference_name: doc.erpnext_name,
          content: htmlLines(lines),
        });
        comment = (r && r.data) || r || null;
        console.log(`• [trust] [${ts()}] ${undoing ? 'undo' : 'review'} comment on ${doc.doctype} ${doc.erpnext_name}`);
      } catch (err) {
        console.error(`[trust] ${undoing ? 'undo' : 'review'} comment failed (${doc.doctype} ${doc.erpnext_name}):`, err.message);
      }
    }
  } catch (err) {
    console.error(`[trust] stock review mark failed (${doc && doc.doctype} ${doc && doc.erpnext_name}):`, err.message);
  }
  return { fingerprint, comment };
}

const CANCELLED_STATUS = 'cancelled'; // trust_fingerprints.review_status of a document an undo cancelled

/**
 * A money document of a lot operation that an undo cancelled (src/lots/gate.js calls this for each
 * one in undo.run's `cancelled` list). It is no longer in the books, so there is nothing to review
 * and nothing to be a duplicate of:
 *   its queue row   → review_status 'cancelled' (listPending and the digest count only 'pending'),
 *                     with the receipt hash, the counterparty and the base amount cleared so the
 *                     duplicate guard and the anomaly medians no longer see it, and a line in its
 *                     warnings saying when it was taken back;
 *   ERPNext         → a Comment on the cancelled document.
 * Idempotent (a retry that finishes the undo calls it again for the same document) and never throws.
 * @param {object} erp  per-user ErpNextClient (null → local row only)
 * @param {{ user, doc: { doctype, erpnext_name }, op?: object, reference?: string }} args
 *   op is the undo plan of lots/undo.js (named in the Comment when given)
 * @returns {Promise<{ fingerprint: object|null, comment: object|null }>}
 */
async function markCancelled(erp, { user, doc, op = null, reference = null }) {
  let fingerprint = null;
  let comment = null;
  try {
    const isoNow = new Date().toISOString();
    const t = (op && op.target) || {};
    let first = true;
    try {
      const had = user && doc ? await fingerprintOf(user.id, doc) : null;
      if (had && had.review_status === CANCELLED_STATUS) {
        fingerprint = had;
        first = false;
      } else if (had) {
        const list = had.warnings ? JSON.parse(had.warnings) : [];
        const note = `Taken back on ${isoNow.slice(0, 10)} (undo): the document is cancelled`;
        const r = await query(
          `UPDATE trust_fingerprints SET review_status = $2, receipt_hash = NULL, counterparty_name = NULL, base_amount = NULL, warnings = $3
           WHERE id = $1 RETURNING *`,
          [had.id, CANCELLED_STATUS, JSON.stringify([...list, note])]
        );
        fingerprint = r.rows[0] || had;
      }
    } catch (err) {
      console.error(`[trust] cancelled mark failed (${doc.doctype} ${doc.erpnext_name}):`, err.message);
    }
    if (erp && first) {
      try {
        const r = await erp.createResource('Comment', {
          comment_type: 'Comment',
          reference_doctype: doc.doctype,
          reference_name: doc.erpnext_name,
          content: htmlLines([
            UNDO_NOTE,
            `Taken back on ${isoNow.slice(0, 10)}${reference ? ` (Berpal ref ${reference})` : ''}: this ${doc.doctype} was cancelled because the stock operation it belonged to`
              + `${t.kind ? ` (${opWords(t)}${t.date ? ` of ${t.date}` : ''})` : ''} was undone.`,
          ]),
        });
        comment = (r && r.data) || r || null;
        console.log(`• [trust] [${ts()}] undo comment on ${doc.doctype} ${doc.erpnext_name}`);
      } catch (err) {
        console.error(`[trust] undo comment failed (${doc.doctype} ${doc.erpnext_name}):`, err.message);
      }
    }
  } catch (err) {
    console.error(`[trust] cancelled mark failed (${doc && doc.doctype} ${doc && doc.erpnext_name}):`, err.message);
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
      if (!row || row.review_status === CANCELLED_STATUS) notFound.push(n); // a cancelled document is not in the books to review
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
  markPosted, markStockPosted, markCancelled, listPending, pendingSummary, markReviewed, commentText, reviewedCommentText,
  REVIEW_NOTE, UNDO_NOTE, STOCK_DIRECTION, CANCELLED_STATUS, STALE_REVIEW_DAYS, MAX_NAMES, MAX_NOTE_CHARS,
};
