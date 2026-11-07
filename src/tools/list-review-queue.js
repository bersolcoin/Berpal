const review = require('../trust/review');

const MAX_LIMIT = 50;

const definition = {
  name: 'list_review_queue',
  description:
    'Documents the bot posted that the accountant has not reviewed yet, oldest first. Plain data: render one line per item yourself. total is the whole queue; shown is how many items came back.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max items to return. Default 30, max 50.' },
      older_than_days: { type: 'number', description: 'Only items pending at least this many days.' },
    },
  },
};

const daysSince = (iso, now) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86400000));

/** The queue as the model renders it. Also used by mark_reviewed on count_changed, so it can re-show the queue in one turn. */
async function queueView(userId, { limit = 30, olderThanDays = null, now = new Date() } = {}) {
  const { total, rows } = await review.listPending(userId, { limit, olderThanDays, now });
  return {
    total,
    shown: rows.length,
    items: rows.map((r) => ({
      name: r.erpnext_name,
      doctype: r.doctype,
      date: r.transaction_date,
      direction: r.direction,
      amount: r.amount,
      currency: r.currency,
      counterparty: r.counterparty_name,
      warnings: r.warnings,
      days_pending: daysSince(r.created_at, now),
    })),
  };
}

async function execute(args, ctx) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit) || 30)));
  const olderThanDays = args.older_than_days == null ? null : Number(args.older_than_days);
  if (olderThanDays != null && !(olderThanDays >= 0)) return { ok: false, error: 'older_than_days must be a number ≥ 0' };
  return { ok: true, ...(await queueView(ctx.user.id, { limit, olderThanDays })) };
}

module.exports = { definition, execute, queueView };
