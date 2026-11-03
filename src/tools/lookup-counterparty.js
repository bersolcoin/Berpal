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
  if (matches.length === 0) {
    return {
      ok: true, count: 0, matches,
      hint: `No contact named "${args.search}" — they are NEW. For an invoice/bill, ask for their phone + nickname (or 'skip') ONCE. If counterparty_contact_skipped is already true in the draft, do NOT ask again: call request_confirmation now.`,
    };
  }
  return { ok: true, count: matches.length, matches };
}

module.exports = { definition, execute };
