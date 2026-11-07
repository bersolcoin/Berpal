const review = require('../trust/review');
const { channelOf } = require('../channels/address');
const { getErp } = require('./context');
const { queueView } = require('./list-review-queue');

const definition = {
  name: 'mark_reviewed',
  description:
    'Mark bot-posted documents as reviewed by the accountant. Pass names (from list_review_queue), or all=true with expected_count = the total list_review_queue returned in this conversation; if the queue changed since, the result is { ok:false, reason:"count_changed" } — list again. Only documents in `marked` are reviewed. Nothing is posted to the ledger.',
  parameters: {
    type: 'object',
    properties: {
      names: { type: 'array', items: { type: 'string' }, description: 'ERPNext names, e.g. ["ACC-JV-2026-00012"]. Max 50.' },
      all: { type: 'boolean', description: 'Mark the whole queue. Requires expected_count.' },
      expected_count: { type: 'number', description: 'With all=true: the total from the list_review_queue the user saw.' },
      note: { type: 'string', description: 'Optional note from the user, kept with the review (≤ 300 chars).' },
    },
  },
};

async function execute(args, ctx) {
  const names = Array.isArray(args.names) ? args.names.filter((n) => typeof n === 'string' && n.trim()) : [];
  const all = args.all === true;
  if (all && !Number.isFinite(Number(args.expected_count))) {
    return { ok: false, error: 'all=true needs expected_count: the total from list_review_queue in this conversation. Call list_review_queue first if you have not.' };
  }
  if (!all && !names.length) {
    return { ok: false, error: 'Pass names (non-empty strings) or all=true with expected_count.' };
  }
  if (!all && names.length > review.MAX_NAMES) {
    return { ok: false, error: `At most ${review.MAX_NAMES} names per call; split them or use all=true with expected_count.` };
  }
  // A channel label, never the address itself: it ends up in a Comment on the ERPNext document.
  const reviewer = `owner via ${channelOf(ctx.user.phone) || 'whatsapp'}`;
  const r = await review.markReviewed(getErp(ctx), {
    user: ctx.user,
    names: all ? null : names,
    all,
    expectedCount: all ? Number(args.expected_count) : null,
    note: typeof args.note === 'string' ? args.note : null,
    reviewer,
  });
  // The guard tripped: hand the model the queue as it is now, so it shows it and asks in this same
  // turn instead of (maybe) remembering to call list_review_queue first.
  if (r.ok === false && r.reason === 'count_changed') return { ...r, ...(await queueView(ctx.user.id)) };
  return r;
}

module.exports = { definition, execute };
