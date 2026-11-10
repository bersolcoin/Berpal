const wallets = require('../wallets');
const { getErp } = require('./context');

const definition = {
  name: 'create_user_account',
  description:
    'Create a wallet. Returns the wallet with its id; existed=true if a wallet with this name + currency already exists (nothing new created — consider the reconcile flow).',
  parameters: {
    type: 'object',
    required: ['name', 'parent_code', 'currency'],
    properties: {
      name: { type: 'string', description: 'e.g. "BBL Savings".' },
      parent_code: { type: 'string', enum: ['1000', '1100', '2100'], description: '1000 cash, 1100 bank, 2100 credit card.' },
      currency: { type: 'string', description: 'ISO 4217 code.' },
    },
  },
};

async function execute(args, ctx) {
  const r = await wallets.create(ctx.user, getErp(ctx), args);
  if (r.wallet) {
    delete r.wallet.erpnext_account;
    ctx.draft.wallet_options = [...new Set([...(ctx.draft.wallet_options || []), r.wallet.id])];
  }
  return r;
}

module.exports = { definition, execute };
