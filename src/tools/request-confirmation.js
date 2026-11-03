const { ts } = require('../erp-sync/common');
const { validateDraft, readinessError } = require('./validate');

const definition = {
  name: 'request_confirmation',
  description:
    'Indicates you have all required fields and your text reply contains a clean summary for the user to confirm. Use only when amount, currency, direction, and transaction_date are all set in the draft.',
  parameters: { type: 'object', properties: {} },
};

async function execute(args, ctx) {
  const missing = validateDraft(ctx.draft);
  if (missing.length) {
    return {
      ok: false,
      error: `Required fields still missing: ${missing.join(', ')}. Ask the user for them before requesting confirmation.`,
    };
  }
  const problem = await readinessError(ctx.user, ctx.draft);
  if (problem) return { ok: false, error: problem };

  ctx.confirmationRequested = true;
  console.log(`• [tools] [${ts()}] tool=request_confirmation user_id=${ctx.user.id}`);
  return { ok: true };
}

module.exports = { definition, execute };
