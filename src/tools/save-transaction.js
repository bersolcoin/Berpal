const { saveDraft } = require('../erp-sync');
const { validateDraft, readinessError, applyDefaults } = require('./validate');
const { getErp } = require('./context');
const { cardSignature } = require('./request-confirmation');
const { attachToDoc } = require('../media/attach');
const review = require('../trust/review');

const definition = {
  name: 'save_transaction',
  description:
    'Save the draft as a confirmed transaction. ONLY call after the user has explicitly confirmed (yes/save/ok in response to your confirmation summary). Never auto-save.',
  parameters: { type: 'object', properties: {} },
};

async function execute(args, ctx) {
  // A card must have gone out in an EARLIER turn: when a turn that sent a card ends, handle()
  // stores the signature of THAT card in confirmation_pending. request_confirmation never touches
  // it, so re-signing in this turn can't stand in for the user's tap. The only card-less save is
  // the missed-sale chain: a payment settling a document saved earlier in this same turn.
  const chained = ctx.draft.transaction_type === 'payment' && !!ctx.draft.parent_invoice_name
    && (ctx.savedIds || []).includes(ctx.draft.parent_invoice_name);
  if (typeof ctx.draft.confirmation_pending !== 'string' && !chained) {
    return {
      ok: false,
      error: 'No confirmation card has been sent for this draft. Call request_confirmation, send the summary, and wait for the user to confirm in their next message.',
    };
  }
  await applyDefaults(ctx.user, ctx.draft);
  const missing = validateDraft(ctx.draft);
  if (missing.length) {
    return { ok: false, error: `Cannot save; missing required fields: ${missing.join(', ')}.` };
  }
  const problem = await readinessError(ctx.user, ctx.draft, () => getErp(ctx));
  if (problem) return { ok: false, error: `Cannot save; ${problem}` };
  // Save exactly what the user saw: any change since that card (amount, wallet, receipt…) means
  // they haven't confirmed this version. Compared after applyDefaults, which request_confirmation
  // also ran before signing.
  if (!chained && ctx.draft.confirmation_pending !== cardSignature(ctx.draft)) {
    return {
      ok: false,
      error: 'The draft changed after the confirmation card was sent, so the user has not confirmed this version. Call request_confirmation again, send the updated summary, and wait for their reply.',
    };
  }

  // Read before saveDraft: the draft is cleared right after a successful save.
  const mediaId = ctx.draft.receipt_media_id;
  const confirmed = { ...ctx.draft };
  try {
    const saved = await saveDraft(ctx.user, getErp(ctx), ctx.draft);
    ctx.saved = saved;
    ctx.savedIds = [...(ctx.savedIds || []), saved.erpnext_name];
    // Clear the draft so a chained save in the same turn (missed-sale flow) starts fresh.
    ctx.draft = {};
    ctx.confirmationRequested = false;
    // Duplicate fingerprint + "awaiting accountant review" Comment. Before the attachment (which
    // deletes the receipt blob the fingerprint hashes). Never throws: the doc is already posted.
    await review.markPosted(getErp(ctx), { user: ctx.user, saved, draft: confirmed, mediaId });
    if (mediaId) {
      // The transaction is already posted; a failed attachment must not turn the save into an error.
      try {
        await attachToDoc(getErp(ctx), { userId: ctx.user.id, mediaId, doctype: saved.doctype, docname: saved.erpnext_name });
      } catch (err) {
        console.error(`[tools] receipt attach failed (media ${mediaId}, ${saved.doctype} ${saved.erpnext_name}):`, err.message);
      }
    }
    return { ok: true, ...saved };
  } catch (err) {
    console.error('[tools] save error:', err.message);
    return { ok: false, error: `Save failed: ${err.message}` };
  }
}

module.exports = { definition, execute };
