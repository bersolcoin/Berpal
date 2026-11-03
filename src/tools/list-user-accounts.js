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
  const ids = list.map((w) => w.id);
  // Remember what was offered so request_confirmation can reject stale ids (see validate.js).
  // A bare "2" next turn is resolved against the picker as the user saw it in the reply
  // (conversation.js shownWalletOptions), matched by wallet name among these offers.
  ctx.draft.wallet_options = [...new Set([...ids, ...(ctx.draft.wallet_options || [])])];
  const result = {
    ok: true,
    count: list.length,
    accounts: list.map(({ erpnext_account, ...w }, i) => ({ option: i + 1, ...w })),
    picker: 'If you show a picker, list these wallets in THIS order numbered by `option` (1..N), each line starting with the wallet name exactly, e.g. "1. BBL Savings". The user\'s number is resolved to the wallet for you. payment_account_id takes the wallet `id`, never the option number.',
  };
  // The model sometimes runs the wallet picker for an invoice/bill, which never touches a wallet
  // (AR/AP only) — and then loops on it. Say so where it will read it.
  const tt = ctx.draft.transaction_type;
  if (tt === 'invoice_issued' || tt === 'bill_received') {
    result.note = `The current draft is ${tt}: it posts to receivables/payables and needs NO wallet. Do not show a wallet picker for it — call request_confirmation (or answer the user's question).`;
  }
  return result;
}

module.exports = { definition, execute };
