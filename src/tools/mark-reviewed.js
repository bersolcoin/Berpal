const review = require('../trust/review');
const { channelOf } = require('../channels/address');
const { getErp } = require('./context');
const lots = require('../lots');
const { queueView, MISMATCH_PREFIX } = require('./list-review-queue');

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

/** LOT-CHECK names of this user's open stock mismatches; [] for anyone who is not a gem trader. */
async function openMismatches(user) {
  if (!lots.isGems(user)) return [];
  try {
    const reconcile = require('../lots/reconcile'); // eslint-disable-line global-require
    return (await reconcile.open(user)).map((m) => `${MISMATCH_PREFIX}${m.id}`);
  } catch (err) {
    console.error(`[review] stock mismatches failed (user ${user.id}):`, err.message);
    return [];
  }
}

const NOT_REVIEWABLE =
  'an open difference between the lots in Berpal and the stock in ERPNext, not a document: it cannot be marked reviewed and closes by itself once the nightly check no longer finds it';

/**
 * Names that mean an open stock mismatch (LOT-CHECK-<id> from list_review_queue) are taken out
 * before the documents are marked: a mismatch is closed by the nightly check, never from chat.
 * Anything else, a closed or unknown LOT-CHECK included, stays in `names` and comes back not_found.
 */
function splitMismatches(names, open) {
  const openNames = new Set(open.map((n) => n.toLowerCase()));
  const isOpen = (n) => openNames.has(n.trim().toLowerCase());
  return { refused: [...new Set(names.filter(isOpen).map((n) => n.trim().toUpperCase()))], rest: names.filter((n) => !isOpen(n)) };
}

async function execute(args, ctx) {
  let names = Array.isArray(args.names) ? args.names.filter((n) => typeof n === 'string' && n.trim()) : [];
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
  // Gem traders only: the queue also shows open stock mismatches, and those are not ours to close.
  const open = await openMismatches(ctx.user);
  let notReviewable = [];
  if (!all && open.length) {
    const { refused, rest } = splitMismatches(names, open);
    notReviewable = refused.map((name) => ({ name, reason: NOT_REVIEWABLE }));
    names = rest;
    if (!names.length) {
      return { ok: false, error: `${refused.join(', ')}: ${NOT_REVIEWABLE}. Nothing was marked.`, not_reviewable: notReviewable, stock_mismatches_open: open.length };
    }
  }
  const extra = open.length ? { ...(notReviewable.length ? { not_reviewable: notReviewable } : {}), stock_mismatches_open: open.length } : {};
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
  return open.length ? { ...r, ...extra } : r;
}

module.exports = { definition, execute };
