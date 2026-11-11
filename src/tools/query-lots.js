const store = require('../lots/store');
const lots = require('../lots');
const { figure, plain } = require('../lots/draft');
const { round2, companyCurrency } = require('../erp-sync/common');

const MAX_ROWS = 500;
const PLACE_WORDS = { stores: 'in stock', work: 'out for work', memo: 'out on memo' };

const definition = {
  name: 'query_lots',
  description:
    'The trader\'s gem lots: code, what it is, carats, pieces, cost and cost per carat (company currency), where it is and with whom. For "what do I have", "show me the sapphires", "what does L12 cost", and to find a lot\'s code before an operation. Totals cover every match, the rows are the newest. Who holds what / overdue: query_custody; one lot\'s story: query_lot_history. message="no_lots" when nothing matches.',
  parameters: {
    type: 'object',
    properties: {
      place: { type: 'string', enum: Object.keys(lots.PLACES), description: 'stores = in the office, work = out with a cutter / heater, memo = out on memo.' },
      form: { type: 'string', enum: lots.FORMS },
      search: { type: 'string', description: 'Part of a code, description, species, variety, colour, origin or supplier.' },
      holder: { type: 'string', description: 'Only lots out with this person (part of the name).' },
      include_empty: { type: 'boolean', description: 'Also lots with nothing left. Default false.' },
      limit: { type: 'number', description: `Rows to return (default 20, 1 to ${MAX_ROWS}).` },
    },
  },
};

const words = (l) => l.description || [l.colour, l.variety || l.species, l.form].filter(Boolean).join(' ') || null;

/** Lean row for the model: no empty fields. */
function row(l) {
  const out = { code: l.code, what: words(l), carats: l.carats, pieces: l.pieces, cost: l.cost };
  if (l.carats > 0) out.cost_per_ct = round2(l.cost / l.carats);
  out.place = PLACE_WORDS[l.location] || l.location;
  if (l.holder) out.holder = l.holder;
  if (l.form) out.form = l.form;
  if (l.treatment) out.treatment = l.treatment;
  if (l.grade) out.grade = l.grade;
  if (l.weight_estimated) out.weight_estimated = true;
  if (l.ask_per_ct != null) out.ask_per_ct = l.ask_per_ct;
  if (l.status !== 'active') out.empty = true;
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

const fail = (error) => ({ ok: false, error });

async function execute(args, ctx) {
  const { user } = ctx;
  // A filter that is not understood is an error, never dropped: the trader would be told about "all" lots.
  for (const [key, list] of [['place', Object.keys(lots.PLACES)], ['form', lots.FORMS]]) {
    if (args[key] != null && args[key] !== '' && !(typeof args[key] === 'string' && list.includes(args[key]))) {
      return fail(`${key} "${args[key]}" is not one of ${list.join(', ')}. Pass one of these, or leave it out for all.`);
    }
  }
  const text = {};
  for (const key of ['holder', 'search']) {
    if (args[key] == null || args[key] === '') continue;
    const v = plain(args[key]);
    if (v === null) return fail(`${key} must be a word or a few words.`);
    if (v) text[key] = v;
  }
  const limitSaid = args.limit == null || args.limit === '' ? 20 : figure(args.limit);
  if (limitSaid === null) return fail('limit must be a number of rows.');
  const limit = Math.max(1, Math.min(Math.floor(limitSaid) || 1, MAX_ROWS));

  const filters = {
    status: args.include_empty === true ? 'all' : 'active',
    location: args.place || undefined,
    form: args.form || undefined,
    holder: text.holder,
    search: text.search,
  };
  const found = await store.listLots(user.id, { ...filters, limit });
  const currency = companyCurrency(user);
  // Totals cover every match, not only the rows read here.
  const t = await store.lotTotals(user.id, filters);
  const totals = { lots: t.count, carats: lots.round3(t.carats), cost: round2(t.cost), cost_currency: currency };
  if (!found.length) return { ok: true, message: 'no_lots', lots: [], totals };

  const rows = found.map(row);
  const more = t.count - rows.length;
  return {
    ok: true,
    lots: rows,
    totals,
    ...(more > 0 ? { note: `${more} more lot(s) match and are counted in totals but not listed. Narrow the search, or say how many there are.` } : {}),
  };
}

module.exports = { definition, execute, niche: 'gems' };
