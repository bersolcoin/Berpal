const store = require('../lots/store');
const lots = require('../lots');
const { round2, companyCurrency } = require('../erp-sync/common');

const PLACE_WORDS = { stores: 'in stock', work: 'out for work', memo: 'out on memo' };
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] == null) delete o[k]; return o; };

const definition = {
  name: 'query_lot_history',
  description:
    'One gem lot: what it holds now, everything done with it (newest first, each with its reference BPL-…, date, carats, value, fee, yield, documents), where it came from, what became of it, and its certificates. For "where did L15 come from", "what happened to L13", and to find an operation\'s reference before an undo. message="no_such_lot" when the code is unknown.',
  parameters: {
    type: 'object',
    properties: {
      lot: { type: 'string', description: 'Lot code, e.g. "L13".' },
      include_undone: { type: 'boolean', description: 'Also operations that were taken back. Default false.' },
    },
    required: ['lot'],
  },
};

const link = (x) => clean({
  code: x.code, steps_away: x.depth, carats: x.carats, value: x.value,
  by: x.via && [x.via.job || x.via.kind, x.via.date, x.via.reference].filter(Boolean).join(' '),
});

async function execute(args, ctx) {
  const { user } = ctx;
  const said = typeof args.lot === 'string' ? args.lot.trim() : '';
  const code = lots.normCode(said);
  const tree = code ? await store.lineage(user.id, code) : null;
  if (!tree) return { ok: true, message: 'no_such_lot', lot: said };

  const l = tree.lot;
  const operations = (await store.history(user.id, code, { limit: 20, includeUndone: args.include_undone === true })).map((o) => clean({
    reference: o.reference,
    kind: o.kind,
    job: o.job,
    direction: o.direction,
    status: o.status === 'posted' ? null : o.status,
    date: o.date,
    holder: o.holder,
    fee_into_cost: o.fee_amount,
    yield_pct: o.yield_pct,
    note: o.note,
    // This lot's own lines: "in" = taken from it, "out" = what it received or became.
    lines: (o.lines || []).map((x) => clean({ role: x.role, carats: x.carats, pieces: x.pieces, damaged_pieces: x.damaged_pieces || null, value: x.value, place: x.place })),
    documents: (o.docs || []).filter((d) => !d.cancelled).map((d) => `${d.doctype} ${d.name}`),
  }));
  const certificates = (await store.listCertificates(l.id)).map((c) => clean({
    lab: c.lab, report_no: c.report_no, report_date: c.report_date, stated_carats: c.stated_carats, url: c.url,
    outdated: c.outdated ? true : null,
  }));

  return {
    ok: true,
    lot: clean({
      code: l.code,
      what: l.description || [l.colour, l.variety || l.species, l.form].filter(Boolean).join(' ') || null,
      carats: l.carats,
      pieces: l.pieces,
      cost: l.cost,
      cost_per_ct: l.carats > 0 ? round2(l.cost / l.carats) : null,
      place: PLACE_WORDS[l.location] || l.location,
      holder: l.holder,
      form: l.form,
      treatment: l.treatment,
      empty: l.status !== 'active' ? true : null,
    }),
    cost_currency: companyCurrency(user),
    operations,
    came_from: tree.ancestors.map(link),
    became: tree.descendants.map(link),
    certificates,
    ...(operations.length ? {} : { note: 'Nothing is recorded against this lot yet.' }),
  };
}

module.exports = { definition, execute, niche: 'gems' };
