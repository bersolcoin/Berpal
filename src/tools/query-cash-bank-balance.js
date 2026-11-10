const { getCashBankBalance } = require('../erp-query/cash-balance');
const { getErp } = require('./context');

const definition = {
  name: 'query_cash_bank_balance',
  description:
    'Current balance of each wallet (cash, bank, credit card) plus totals per currency. message="no_accounts" when the user has no wallets. A negative credit-card balance is money owed on the card.',
  parameters: {
    type: 'object',
    properties: {
      currency: { type: 'string', description: 'Only wallets in this currency.' },
      wallet_id: { type: 'number', description: 'Only this wallet.' },
    },
  },
};

async function execute(args, ctx) {
  return getCashBankBalance(ctx.user, getErp(ctx), args);
}

module.exports = { definition, execute };
