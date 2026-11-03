const { ts } = require('../erp-sync/common');
const mediaIntake = require('../media');

const definition = {
  name: 'cancel_transaction',
  description:
    'Discard the current draft and reset. Call if user says cancel, forget it, never mind, etc.',
  parameters: { type: 'object', properties: {} },
};

async function execute(args, ctx) {
  ctx.cancelled = true;
  // The draft is dropped unsaved: delete its receipt now, not after the 7-day purge (user-scoped, never throws).
  if (ctx.draft && ctx.draft.receipt_media_id) await mediaIntake.discard(ctx.user.id, [ctx.draft.receipt_media_id]);
  console.log(`• [tools] [${ts()}] tool=cancel_transaction user_id=${ctx.user.id}`);
  return { ok: true };
}

module.exports = { definition, execute };
