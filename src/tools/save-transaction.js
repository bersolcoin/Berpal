const { saveDraft } = require('../erp-sync');
const { validateDraft, readinessError } = require('./validate');
const { getErp } = require('./context');

const definition = {
  name: 'save_transaction',
  description:
    'Save the draft as a confirmed transaction. ONLY call after the user has explicitly confirmed (yes/save/ok in response to your confirmation summary). Never auto-save.',
  parameters: { type: 'object', properties: {} },
};

async function execute(args, ctx) {
  const missing = validateDraft(ctx.draft);
  if (missing.length) {
    return { ok: false, error: `Cannot save; missing required fields: ${missing.join(', ')}.` };
  }
  const problem = await readinessError(ctx.user, ctx.draft);
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
