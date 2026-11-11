const custody = require('../lots/custody');
const lots = require('../lots');
const { round2, companyCurrency } = require('../erp-sync/common');

const MAX_ROWS = 60;

const definition = {
  name: 'query_custody',
  description:
    'Stones that are out of the office right now: with a cutter / heater for work, or with a broker / customer on memo. Grouped by holder; per lot the carats still out (sent, less what came back or was sold), pieces, cost (company currency), date sent, days out, due date, overdue (past its due date, or out for work over 30 days with no date agreed) and the memo price per carat. Use for "what is out", "what does Somchai have", "what is on memo", "what is overdue", "who is late". message="nothing_out" when nothing matches.',
  parameters: {
    type: 'object',
    properties: {
      holder: { type: 'string', description: 'Only this holder (part of the name is enough), e.g. "Somchai".' },
      purpose: { type: 'string', enum: ['work', 'memo'], description: 'work = out with a cutter / heater; memo = out on consignment. Omit for both.' },
      overdue_only: { type: 'boolean', description: 'Only what is late. Default false.' },
    },
  },
};

async function execute(args, ctx) {
  const { user } = ctx;
  const opts = { holder: args.holder ? String(args.holder).trim() : undefined, purpose: ['work', 'memo'].includes(args.purpose) ? args.purpose : undefined };
  let groups = await custody.out(user, opts);
  if (args.overdue_only) {
    groups = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => r.overdue) })).filter((g) => g.rows.length);
  }
  const all = groups.flatMap((g) => g.rows);
  const sum = (rows, f) => rows.reduce((s, r) => s + r[f], 0);
  const totals = {
    lots: all.length,
    carats: lots.round3(sum(all, 'carats')),
    cost: round2(sum(all, 'cost')),
    cost_currency: companyCurrency(user),
    overdue: all.filter((r) => r.overdue).length,
  };
  if (!all.length) return { ok: true, message: 'nothing_out', holders: [], totals };

  // Lean rows for the model: no empty fields, the oldest first, capped.
  let left = MAX_ROWS;
  const holders = [];
  for (const g of groups) {
    if (left <= 0) break;
    const rows = g.rows.slice(0, left).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v != null && v !== false)));
    left -= rows.length;
    holders.push({
      holder: g.holder, purpose: g.purpose, lots: g.rows.length,
      carats: lots.round3(sum(g.rows, 'carats')), cost: round2(sum(g.rows, 'cost')), rows,
    });
  }
  return { ok: true, holders, totals, ...(all.length > MAX_ROWS ? { truncated: true, shown: MAX_ROWS } : {}) };
}

module.exports = { definition, execute, niche: 'gems' };
