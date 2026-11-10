const { getStock } = require('../erp-query/stock');
const { getErp } = require('./context');

const definition = {
  name: 'query_stock',
  description:
    'Stock on hand from ERPNext: per item and warehouse, qty, valuation rate (cost per unit) and stock value, plus totals (company currency). Use for "what\'s in stock", "do I still have pa2293", "where is R-17", "stock value". message="unknown_item" when the code was never bought/sold through the bot; "not_in_stock" when it exists but qty is 0.',
  parameters: {
    type: 'object',
    properties: {
      item_code: { type: 'string', description: 'A single stock id the user named, e.g. "pa2293".' },
      search: { type: 'string', description: 'Free-text filter on code/name, e.g. "ruby".' },
      include_zero: { type: 'boolean', description: 'Also list items with 0 on hand (sold out). Default false.' },
    },
  },
};

async function execute(args, ctx) {
  return getStock(ctx.user, getErp(ctx), args);
}

module.exports = { definition, execute };
