const { ts } = require('../erp-sync/common');

const definition = {
  name: 'cancel_transaction',
  description:
    'Discard the current draft and reset. Call if user says cancel, forget it, never mind, etc.',
  parameters: { type: 'object', properties: {} },
};

async function execute(args, ctx) {
  ctx.cancelled = true;
  console.log(`• [tools] [${ts()}] tool=cancel_transaction user_id=${ctx.user.id}`);
  return { ok: true };
}

module.exports = { definition, execute };
