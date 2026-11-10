const { getOpenInvoices } = require('../erp-query/open-invoices');
const { getErp } = require('./context');

const definition = {
  name: 'query_open_invoices',
  description:
    'List unpaid invoices (receivables) and/or bills (payables), live from the books. Each row has a `ref` (use it as the invoice number when talking to the user and as parent_invoice_name when settling) and `doctype`. Returns total_count and totals_by_currency for the FULL filtered set even when rows are truncated.',
  parameters: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['receivable', 'payable', 'both'], description: 'Default both.' },
      counterparty_id: { type: 'number', description: 'Exact contact id from lookup_counterparty. Preferred over counterparty_search.' },
      counterparty_search: { type: 'string', description: 'Name fragment. Only use when lookup_counterparty showed a single match.' },
      sort: { type: 'string', enum: ['due_date_asc', 'amount_desc', 'newest'], description: 'Default due_date_asc.' },
      limit: { type: 'number', description: 'Rows to return, default 5, max 50.' },
    },
  },
};

async function execute(args, ctx) {
  return getOpenInvoices(ctx.user, getErp(ctx), args);
}

module.exports = { definition, execute };
