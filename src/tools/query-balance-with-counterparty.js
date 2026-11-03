const { getBalanceWithCounterparty } = require('../erp-query/counterparty-balance');
const { getErp } = require('./context');

const definition = {
  name: 'query_balance_with_counterparty',
  description:
    'Net position with one counterparty per currency: owes_you and you_owe, from the full party ledger (invoices, bills, advances and payments), plus counts of open invoices/bills. Use for "how much does X owe me" style questions.',
  parameters: {
    type: 'object',
    properties: {
      counterparty_id: { type: 'number', description: 'Exact contact id from lookup_counterparty. Preferred.' },
      counterparty_search: { type: 'string', description: 'Name fragment; returns ambiguous=true with matches if several fit.' },
    },
  },
};

async function execute(args, ctx) {
  return getBalanceWithCounterparty(ctx.user, getErp(ctx), args);
}

module.exports = { definition, execute };
