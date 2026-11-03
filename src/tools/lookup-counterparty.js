const counterparties = require('../counterparties');
const { getErp } = require('./context');

const definition = {
  name: 'lookup_counterparty',
  description:
    'Search existing contacts by name or nickname. Each match has id, name, nickname, phone (last digits useful for disambiguation) and exact=true when it is an exact name/nickname match.',
  parameters: {
    type: 'object',
    required: ['search'],
    properties: { search: { type: 'string' } },
  },
};

async function execute(args, ctx) {
  const matches = await counterparties.search(ctx.user, getErp(ctx), args.search);
  return { ok: true, count: matches.length, matches };
}

module.exports = { definition, execute };
