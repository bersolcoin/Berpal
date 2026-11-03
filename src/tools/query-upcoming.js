const { getOpenInvoices } = require('../erp-query/open-invoices');
const { getErp } = require('./context');

const definition = {
  name: 'query_upcoming',
  description:
    'Invoices/bills coming due within the next N days. Overdue items are included and carry overdue_days > 0 so you can tag them.',
  parameters: {
    type: 'object',
    properties: {
      days_ahead: { type: 'number', description: 'Default 7.' },
      direction: { type: 'string', enum: ['receivable', 'payable', 'both'], description: 'Default both.' },
    },
  },
};

async function execute(args, ctx) {
  return getOpenInvoices(ctx.user, getErp(ctx), {
    direction: args.direction || 'both',
    due_within_days: args.days_ahead ?? 7,
    sort: 'due_date_asc',
    limit: 50,
  });
}

module.exports = { definition, execute };
