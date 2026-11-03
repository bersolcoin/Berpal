const { saveDraft } = require('../erp-sync');
const { validateDraft, readinessError, applyDefaults } = require('./validate');
const { getErp } = require('./context');

const definition = {
  name: 'save_transaction',
  description:
    'Save the draft as a confirmed transaction. ONLY call after the user has explicitly confirmed (yes/save/ok in response to your confirmation summary). Never auto-save.',
  parameters: { type: 'object', properties: {} },
};

async function execute(args, ctx) {
  // A card must have gone out in an EARLIER turn (handle() sets confirmation_pending when it
  // persists the draft). The only exception is a chained save right after a confirmed save
  // in this turn (missed-sale flow). Stops the model from saving without the user's tap.
  const chained = (ctx.savedIds || []).length > 0;
  if (!ctx.draft.confirmation_pending && !chained) {
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

  try {
    const saved = await saveDraft(ctx.user, getErp(ctx), ctx.draft);
    ctx.saved = saved;
    ctx.savedIds = [...(ctx.savedIds || []), saved.erpnext_name];
    // Clear the draft so a chained save in the same turn (missed-sale flow) starts fresh.
    ctx.draft = {};
    ctx.confirmationRequested = false;
    return { ok: true, ...saved };
  } catch (err) {
    console.error('[tools] save error:', err.message);
    return { ok: false, error: `Save failed: ${err.message}` };
  }
}

module.exports = { definition, execute };
