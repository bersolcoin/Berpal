const wallets = require('../wallets');
const { getErp } = require('./context');

const definition = {
  name: 'list_user_accounts',
  description:
    "List the user's wallets (cash / bank / credit card). Each has id (use as payment_account_id), name, type, parent_code and currency.",
  parameters: {
    type: 'object',
    properties: {
      parentCodes: {
        type: 'array',
        items: { type: 'string', enum: ['1000', '1100', '2100'] },
        description: '1000 cash, 1100 bank, 2100 credit card. Omit for all.',
      },
      currency: { type: 'string', description: 'Only wallets in this currency.' },
    },
  },
};

async function execute(args, ctx) {
  const list = await wallets.list(ctx.user, getErp(ctx), args);
  // Remember what was offered so request_confirmation can reject stale ids (see validate.js).
  ctx.draft.wallet_options = [...new Set([...(ctx.draft.wallet_options || []), ...list.map((w) => w.id)])];
  return { ok: true, count: list.length, accounts: list.map(({ erpnext_account, ...w }) => w) };
}

module.exports = { definition, execute };
