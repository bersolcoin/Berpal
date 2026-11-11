const review = require('../trust/review');
const lots = require('../lots');

const MAX_LIMIT = 50;
const MAX_MISMATCHES = 20;
/** How an open stock mismatch is named in the queue: LOT-CHECK-<id>. Not a document name. */
const MISMATCH_PREFIX = 'LOT-CHECK-';
const MISMATCH_NOTE =
  'stock_mismatches are differences between the lots in Berpal and the stock in ERPNext, found by the nightly check. They are not documents: they cannot be marked reviewed, and each one closes by itself once the nightly check no longer finds it (after the accountant corrects the books, or the lot is corrected).';

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

/** Stock Entry name → the lot operation it belongs to, for this user's recent operations. */
async function stockOps(userId) {
  const store = require('../lots/store'); // eslint-disable-line global-require
  const { kindWords } = require('../lots/undo'); // eslint-disable-line global-require
  const ops = await store.listOps(userId, { status: ['posted', 'partial', 'undoing', 'undone'], limit: 500 });
  const by = new Map();
  for (const o of ops) {
    for (const d of o.erpnext_docs || []) {
      if (d.doctype === 'Stock Entry') by.set(d.name, { operation: kindWords(o), reference: o.reference, ...(o.status === 'undone' ? { taken_back: true } : {}) });
    }
  }
  return by;
}

/**
 * The second kind of queue item, for gem traders: what the nightly check (src/lots/reconcile.js)
 * found different between Berpal's lots and ERPNext and has not seen put right yet. Kept apart
 * from `items` (and out of `total`): these are not documents and cannot be marked reviewed.
 * @returns {Promise<object>} {} when there is nothing to add, so everyone else's result is unchanged
 */
async function mismatchView(user, { olderThanDays = null, now = new Date() } = {}) {
  if (!lots.isGems(user)) return {};
  try {
    const reconcile = require('../lots/reconcile'); // eslint-disable-line global-require
    const open = (await reconcile.open(user))
      .filter((m) => olderThanDays == null || daysSince(m.first_seen, now) >= olderThanDays);
    if (!open.length) return {};
    return {
      stock_mismatches_total: open.length,
      stock_mismatches: open.slice(0, MAX_MISMATCHES).map((m) => ({
        type: 'stock_mismatch',
        name: `${MISMATCH_PREFIX}${m.id}`,
        kind: m.kind,
        lot: m.lot,
        berpal: m.berpal,
        erpnext: m.erpnext,
        detail: m.detail,
        first_seen: String(m.first_seen).slice(0, 10),
        days_open: daysSince(m.first_seen, now),
      })),
      stock_mismatches_note: MISMATCH_NOTE,
    };
  } catch (err) {
    console.error(`[review] stock mismatches failed (user ${user.id}):`, err.message);
    return {};
  }
}

async function execute(args, ctx) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit) || 30)));
  const olderThanDays = args.older_than_days == null ? null : Number(args.older_than_days);
  if (olderThanDays != null && !(olderThanDays >= 0)) return { ok: false, error: 'older_than_days must be a number ≥ 0' };
  const view = await queueView(ctx.user.id, { limit, olderThanDays });
  // A gem trader's stock entries: say which operation each one belongs to.
  if (lots.isGems(ctx.user) && view.items.some((i) => i.doctype === 'Stock Entry')) {
    try {
      const ops = await stockOps(ctx.user.id);
      view.items = view.items.map((i) => (i.doctype === 'Stock Entry' && ops.has(i.name) ? { ...i, ...ops.get(i.name) } : i));
    } catch (err) {
      console.error(`[review] stock operations failed (user ${ctx.user.id}):`, err.message);
    }
  }
  return { ok: true, ...view, ...(await mismatchView(ctx.user, { olderThanDays })) };
}

module.exports = { definition, execute, queueView, mismatchView, MISMATCH_PREFIX };
