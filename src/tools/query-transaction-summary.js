const { getTransactionSummary } = require('../erp-query/transaction-summary');
const { getErp } = require('./context');

const definition = {
  name: 'query_transaction_summary',
  description:
    'Total income or expense over a period, optionally grouped by category or month. Amounts are in the reporting currency. Resolve period words ("this year", "last month") to ISO dates yourself.',
  parameters: {
    type: 'object',
    required: ['direction'],
    properties: {
      direction: { type: 'string', enum: ['income', 'expense'] },
      date_from: { type: 'string', description: 'ISO YYYY-MM-DD. Default Jan 1 of this year.' },
      date_to: { type: 'string', description: 'ISO YYYY-MM-DD. Default today.' },
      group_by: { type: 'string', enum: ['none', 'category', 'month'], description: 'Default none.' },
      counterparty_id: { type: 'number', description: 'Restrict to invoices/bills with this contact.' },
    },
  },
};

async function execute(args, ctx) {
  return getTransactionSummary(ctx.user, getErp(ctx), args);
}

module.exports = { definition, execute };
