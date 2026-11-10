const { saveDraft } = require('../erp-sync');
const { validateDraft, readinessError, applyDefaults } = require('./validate');
const { getErp } = require('./context');
const { cardSignature } = require('./request-confirmation');
const { attachToDoc } = require('../media/attach');
const review = require('../trust/review');
const { computeTotals } = require('../erp-sync/taxes');

/**
 * What a document saved earlier this turn is still owed, from the confirmed draft (no ERPNext
 * round trip): a fresh invoice is owed its grand total — gross, or gross − WHT for a bill, since
 * only purchase rows deduct WHT — and an advance (Journal Entry) its amount.
 */
function savedDoc(saved, draft) {
  const invoice = saved.doctype === 'Sales Invoice' || saved.doctype === 'Purchase Invoice';
  const t = invoice ? computeTotals(draft) : null;
  const outstanding = !t ? Number(draft.amount) : saved.doctype === 'Purchase Invoice' ? t.due : t.gross;
  return { doctype: saved.doctype, currency: draft.currency, outstanding };
}

/** null when the chained payment settles the parent as the user saw it; otherwise the refusal. */
function chainMismatch(draft, parent) {
  const amount = Number(draft.amount);
  if (parent.currency && draft.currency !== parent.currency) {
    return `the payment is in ${draft.currency} but ${draft.parent_invoice_name} is in ${parent.currency}`;
  }
  if (!(amount > 0)) return 'the payment amount must be greater than 0';
  if (amount > parent.outstanding + 0.005) {
    return `the payment (${amount} ${draft.currency}) exceeds what ${draft.parent_invoice_name} is owed (${parent.outstanding} ${parent.currency})`;
  }
  return null;
}

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
  // The card the user confirmed covered the parent only, so the chained payment may not go beyond
  // it: same currency, and 0 < amount <= what the parent is owed. Anything else needs its own card.
  // After applyDefaults, so a payment the model left without a currency is compared on the
  // defaulted one (as request_confirmation would sign it), not on `undefined`.
  if (chained) {
    const parent = (ctx.savedDocs || {})[ctx.draft.parent_invoice_name];
    const mismatch = parent ? chainMismatch(ctx.draft, parent) : `${ctx.draft.parent_invoice_name} was saved without its totals`;
    if (mismatch) {
      return {
        ok: false,
        error: `Cannot save without a card: ${mismatch}. Call request_confirmation, send the summary, and wait for the user to confirm.`,
      };
    }
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
    ctx.savedDocs = { ...(ctx.savedDocs || {}), [saved.erpnext_name]: savedDoc(saved, confirmed) };
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
