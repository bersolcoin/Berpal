/**
 * Accountant review status for bot-posted documents.
 *   markPosted  → after save_transaction: store the fingerprint (review_status 'pending') and add
 *                 a Comment on the ERPNext document — stock v14 supports Comments on any doctype,
 *                 so no custom field is needed.
 *   listPending → the local queue of documents still awaiting review (Postgres only).
 * Neither the fingerprint nor the Comment may fail the save: the document is already posted.
 */
const { query } = require('../db');
const { ts } = require('../erp-sync/common');
const duplicates = require('./duplicates');
const { fingerprintFields } = require('./index');

const REVIEW_NOTE = 'Berpal: posted from WhatsApp, awaiting accountant review';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Comment content is HTML in ERPNext: escape the lines and break with <br> (a bare \n collapses). */
function commentText(warnings) {
  const list = (warnings || []).filter(Boolean);
  return list.length
    ? [REVIEW_NOTE, 'Warnings shown to the user:', ...list.map((w) => `- ${w}`)].map(escapeHtml).join('<br>')
    : REVIEW_NOTE;
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

/** Documents this user's bot posted that no accountant has reviewed yet, oldest first. */
async function listPending(userId) {
  if (!userId) throw new Error('listPending: userId is required');
  const r = await query(
    `SELECT id, doctype, erpnext_name, direction, amount, currency, transaction_date, counterparty_name, warnings, created_at
     FROM trust_fingerprints WHERE user_id = $1 AND review_status = 'pending' ORDER BY id`,
    [userId]
  );
  return r.rows.map((row) => ({
    ...row,
    amount: row.amount == null ? null : Number(row.amount),
    warnings: row.warnings ? JSON.parse(row.warnings) : [],
  }));
}

module.exports = { markPosted, listPending, commentText, REVIEW_NOTE };
