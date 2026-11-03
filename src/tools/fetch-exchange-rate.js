const exchange = require('../exchange');
const { ts } = require('../erp-sync/common');

const definition = {
  name: 'fetch_exchange_rate',
  description:
    'Fetch the exchange rate from one currency to another for a given date (ECB reference rates via frankfurter.app). Call this when the transaction currency differs from the user\'s reporting currency, BEFORE request_confirmation. After getting the rate, call update_draft with exchange_rate + exchange_rate_source so the saved transaction stores the conversion.',
  parameters: {
    type: 'object',
    required: ['from_currency', 'to_currency'],
    properties: {
      from_currency: { type: 'string', description: 'ISO 4217 code, e.g. "USD".' },
      to_currency: { type: 'string', description: 'ISO 4217 code, e.g. "THB".' },
      date: {
        type: 'string',
        description: 'ISO YYYY-MM-DD; the transaction_date works best. Defaults to today if omitted. Frankfurter may return the previous business day for weekends.',
      },
    },
  },
};

async function execute(args) {
  const result = await exchange.fetchRate(args.from_currency, args.to_currency, args.date);
  console.log(`• [tools] [${ts()}] tool=fetch_exchange_rate ${args.from_currency}->${args.to_currency} date=${args.date || 'today'} rate=${result.rate ?? 'err'} source=${result.source || 'n/a'}`);
  return result;
}

module.exports = { definition, execute };
