/**
 * Draft → ResolvedOp (src/lots/index.js): what one confirmation will do to the lots, worked out
 * from Berpal's own lot rows (store.js reads) and cost.js. Reads only; never writes, never calls
 * ERPNext.
 *
 * The draft has been through draft.prepare already (codes normalised, carats rounded, shapes
 * checked). resolveDraft is called for the card AND again for the save: the same draft against
 * the same lot rows must give the same ResolvedOp (lots.opSignature), and a lot that changed in
 * between must give a different one (inputs[].before). At save time the draft carries the codes
 * the first call assigned (the gate writes them back), so a code on a new output that names no
 * lot is that new lot's code.
 *
 * Every refusal is one instruction to the chat model, in plain English, naming the lot and the
 * figure that is wrong.
 */
const lots = require('./index');
const store = require('./store');
const cost = require('./cost');
const counterparties = require('../counterparties');
const { round2, companyCurrency, txRate } = require('../erp-sync/common');
const { computeTotals, vatTreatment } = require('../erp-sync/taxes');

const EPS = 0.0005; // half a thousandth of a carat: below this a lot is empty (as in store.js)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** What an output line of a stock operation may say about the stones (the rest is inherited). */
const STATED = ['form', 'treatment', 'grade', 'shape', 'size', 'colour', 'clarity', 'description'];
/** What a purchase line may say about the stones. */
const BOUGHT = ['form', 'species', 'variety', 'shape', 'size', 'colour', 'clarity', 'origin', 'grade', 'treatment',
  'treatment_source', 'pricing_basis'];
const PURCHASE_UNIT = { per_ct: 'ct', per_g: 'g', per_kg: 'kg', per_piece: 'piece' };
const DESTINATION = { out_work: 'work', out_memo: 'memo', return: 'stores' };
const WHERE = { stores: 'in stores', work: 'out for work', memo: 'out on memo' };
/** Treatments a recut can damage or remove: the card says so before the trader confirms. */
const FRAGILE = ['H-D', 'H-GF', 'FF-O', 'LGH'];
const JOB_WORDS = { cutting: 'cutting', sawing: 'sawing', heating: 'heating', preform: 'preforming', recut: 'recut', reweigh: 're-weigh' };

/** A refusal is an answer ({ ok: false, error }), not a failure: anything else thrown is a bug. */
class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const ct = (n) => `${lots.round3(n)} ct`;
const sum = (list, pick) => list.reduce((s, x) => s + (Number(pick(x)) || 0), 0);
const pcs = (n) => `${n} ${n === 1 ? 'piece' : 'pieces'}`;
const held = (lot) => (lot.location === 'stores' ? WHERE.stores : `${WHERE[lot.location] || lot.location}${lot.holder ? ` with ${lot.holder}` : ''}`);
const sameName = (a, b) => {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

const DEFAULT_ZONE = 'Asia/Bangkok';

/** Today by the user's own clock (their time zone, else Bangkok's): the default date and the "not in the future" limit both use it. */
function today(user) {
  for (const zone of [user && user.timezone, DEFAULT_ZONE]) {
    if (!zone) continue;
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch { /* an unknown time zone: the next one will do */ }
  }
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD that is a day on the calendar (2026-02-30 is not). */
function isDay(text) {
  if (!ISO_DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function opDate(user, raw) {
  const now = today(user);
  const date = blank(raw) ? now : String(raw).trim();
  if (!ISO_DATE.test(date)) refuse(`The date "${raw}" is not a date. Give it as YYYY-MM-DD; ask the trader when it happened.`);
  if (!isDay(date)) refuse(`The date "${raw}" is not a day on the calendar. Ask the trader when it happened.`);
  if (date > now) refuse(`The date ${date} is in the future. Stones are recorded on the day it happened, today at the latest; ask the trader for the date.`);
  return date;
}

/** Draft currency → company currency. An exchange rate that is missing is the model's to fetch. */
function companyRate(user, draft) {
  if (!draft.currency || draft.currency === companyCurrency(user)) return 1;
  try { return txRate(user, draft); } catch (err) { return refuse(`${err.message}.`); }
}

async function counterpartyName(user, draft) {
  if (draft.counterparty_id) {
    const row = await counterparties.getById(user, draft.counterparty_id);
    if (row && row.name) return row.name;
  }
  return blank(draft.counterparty_name) ? null : String(draft.counterparty_name).trim();
}

/** The attributes of a lot row as a new lot made from it starts with (nothing that is not set). */
function attrsOf(lot, { without = [] } = {}) {
  const attrs = {};
  for (const k of store.ATTRS) {
    if (lot[k] != null && !without.includes(k)) attrs[k] = lot[k];
  }
  return attrs;
}

/** What the output line itself says about the stones. */
function statedAttrs(line) {
  const attrs = {};
  for (const k of STATED) {
    if (!blank(line && line[k])) attrs[k] = typeof line[k] === 'string' ? line[k].trim() : line[k];
  }
  return attrs;
}

/**
 * Several lots into one: what they all agree on stays, the rest is no longer true of the whole.
 * Different treatments make the result 'mixed' (the card warns).
 */
function commonAttrs(rows) {
  const attrs = {};
  for (const k of store.ATTRS) {
    const first = rows[0][k] == null ? null : rows[0][k];
    const same = rows.every((r) => (r[k] == null ? null : r[k]) === first);
    if (same) attrs[k] = first;
    else if (k === 'treatment') attrs[k] = lots.MIXED_TREATMENT;
    else if (k === 'form') attrs[k] = rows[0].form || null;
    else attrs[k] = null;
  }
  return attrs;
}
const dropNulls = (attrs) => Object.fromEntries(Object.entries(attrs).filter(([, v]) => v != null));

/** How many pieces leave a lot. Refuses a count the lot cannot give. */
function piecesTaken(lot, whole, stated, env) {
  const n = blank(stated) ? null : Number(stated);
  if (lot.pieces == null) return n; // the lot is not counted: a count said here is only carried along
  if (whole) {
    if (n != null && n !== lot.pieces) {
      refuse(`Lot ${lot.code} holds ${pcs(lot.pieces)}; taking the whole lot takes all of them, not ${n}. Ask the trader to count again, or leave pieces out.`);
    }
    return lot.pieces;
  }
  if (n == null) {
    env.warnings.push(`The pieces taken from lot ${lot.code} were not counted: the count left in it will no longer be known.`);
    return null;
  }
  if (n > lot.pieces) refuse(`Lot ${lot.code} holds ${pcs(lot.pieces)}; you cannot take ${n} from it. Ask the trader for the right count.`);
  if (n === lot.pieces) {
    refuse(`Taking ${pcs(n)} from lot ${lot.code} takes every piece but leaves weight in it. Ask the trader: is the whole lot taken (leave carats out), or fewer pieces?`);
  }
  return n;
}

/**
 * One input: what is taken from a lot, at its average cost, with the lot as read (`before`).
 * @param {object|undefined} lot  the row, or undefined when the code names no lot of this user
 * @param {{carats?: number|null, pieces?: number|null}} want  carats omitted = the whole lot
 */
function take(lot, code, want, env, { countPieces = true } = {}) {
  if (!lot) refuse(`Lot ${code} is not on record for this account. Check the code with the trader (query_lots lists the lots).`);
  if (lot.status !== 'active' || lot.carats < EPS) refuse(`Lot ${lot.code} is empty: nothing is left in it. Ask the trader which lot they mean (query_lots lists what is on hand).`);
  if (lot.last_op_date && env.date < lot.last_op_date) {
    refuse(`Lot ${lot.code} was last changed on ${lot.last_op_date}, and this is dated ${env.date}, before that. An operation cannot be dated before the lot's last one: ask the trader for the right date.`);
  }
  const carats = blank(want.carats) ? lot.carats : lots.round3(want.carats);
  if (!(carats > 0)) refuse(`The weight taken from lot ${lot.code} must be more than 0 ct. Ask the trader for it.`);
  if (carats > lot.carats + EPS) refuse(`Lot ${lot.code} holds ${ct(lot.carats)}; you cannot take ${ct(carats)} from it. Ask the trader to check the weight.`);
  const whole = lots.round3(lot.carats - carats) < EPS;
  return {
    code: lot.code, lot_id: lot.id, carats: whole ? lot.carats : carats,
    pieces: countPieces ? piecesTaken(lot, whole, want.pieces, env) : null,
    cost: whole ? round2(lot.cost) : cost.costOfTaking(lot, carats),
    whole, from: lot.location, item: lot.erpnext_item, batch: lot.erpnext_batch,
    before: {
      carats: lot.carats, pieces: lot.pieces, cost: lot.cost, form: lot.form, treatment: lot.treatment,
      species: lot.species, variety: lot.variety, colour: lot.colour,
      holder: lot.holder, description: lot.description, last_op_date: lot.last_op_date,
    },
  };
}

/** The lots a stock operation takes from, in the order given. */
async function takeInputs(user, sop, env, opts) {
  const list = Array.isArray(sop.inputs) ? sop.inputs : [];
  if (!list.length) refuse('stock_op.inputs must list the lot(s) this is done to. Ask the trader which lot.');
  const wants = list.map((inp) => (typeof inp === 'string' ? { lot: inp } : inp || {}));
  const codes = wants.map((inp, i) => lots.normCode(inp.lot || inp.code)
    || refuse(`stock_op.inputs[${i}] needs the code of a lot. Ask the trader which lot (query_lots lists them).`));
  const twice = codes.find((c, i) => codes.indexOf(c) !== i);
  if (twice) refuse(`Lot ${twice} is listed twice in stock_op.inputs. List each lot once.`);
  const rows = await store.getLots(user.id, codes);
  const inputs = wants.map((inp, i) => take(rows.get(codes[i]), codes[i], inp, env, opts));
  return { inputs, rows: inputs.map((inp) => rows.get(inp.code)) };
}

/**
 * Codes for the lots an operation creates: the one the line states (it must be free), else the
 * next free L<n>. `keep` are codes an output may state because it IS that existing lot.
 * @returns {Promise<string[]>} one code per line, in order
 */
async function outputCodes(user, lines, { keep = [], at = (i) => `stock_op.outputs[${i}]`, hint = '' } = {}) {
  const stated = lines.map((l, i) => {
    if (blank(l && l.code)) return null;
    // normCode closes up a space ("A B" would become "AB"): a new lot's code is never made up that way.
    if (/\S\s+\S/.test(String(l.code))) refuse(`${at(i)}.code "${l.code}" has a space in it, and a lot code has none. Ask the trader for the code, or leave it out and one is assigned.`);
    return lots.normCode(l.code) || refuse(`${at(i)}.code "${l.code}" cannot be a lot code. Ask the trader for the code, or leave it out and one is assigned.`);
  });
  const given = stated.filter(Boolean);
  const twice = given.find((c, i) => given.indexOf(c) !== i);
  if (twice) refuse(`Lot ${twice} is given to two lines. Each one is its own lot.`);
  const fresh = given.filter((c) => !keep.includes(c));
  const existing = await store.getLots(user.id, fresh);
  for (const code of fresh) {
    if (existing.has(code)) {
      refuse(`Lot ${code} already exists, so it cannot be the code of a new lot. Leave the code out and one is assigned, or ask the trader for another code.${hint}`);
    }
  }
  const next = await store.nextCodes(user.id, stated.filter((c) => !c).length, { taken: given });
  return stated.map((c) => c || next.shift());
}

/** The fields every ResolvedOp has; each kind fills in its own. */
const blankOp = (user, env) => ({
  kind: null, job: null, direction: null, date: env.date, method: lots.costMethod(user), inputs: [], outputs: [], fee: null,
  yield_pct: null, loss_carats: 0, holder: null, due_date: null, memo_price_per_ct: null, reason: null, note: null,
  counterparty: null, warnings: env.warnings,
});

const newOutput = (o) => ({
  new: true, lot_id: null, pieces: null, damaged_pieces: 0, to: 'stores', revision: 0, weight_estimated: false, line: null, attrs: {}, ...o,
});

/** What the stones in a stock operation's outputs weigh; every output needs its weight. */
function outputLines(sop) {
  const list = Array.isArray(sop.outputs) ? sop.outputs : [];
  list.forEach((o, i) => {
    if (!o || typeof o !== 'object' || !(lots.round3(o.carats) > 0)) refuse(`stock_op.outputs[${i}] needs its weight in carats. Ask the trader for it.`);
  });
  return list;
}

/** Put `total` on the outputs by the user's method; the last one takes the rounding. */
function shareCost(outputs, lines, total, method) {
  const r = cost.outputCosts({
    total, method,
    outputs: outputs.map((o, i) => ({ code: blank(lines[i].code) ? null : o.code, carats: o.carats, value: lines[i].value, value_per_ct: lines[i].value_per_ct })),
  });
  if (!r.ok) refuse(r.error);
  outputs.forEach((o, i) => { o.cost = r.costs[i]; });
}

/** The one holder of the lots that are out; null when none is out or they are with different people. */
function commonHolder(rows) {
  const names = [...new Set(rows.filter((l) => l.location !== 'stores' && l.holder).map((l) => l.holder))];
  return names.length === 1 ? names[0] : null;
}

const yes = (v) => v === true || v === 1 || String(v).toLowerCase() === 'true';
const count = (v) => (blank(v) ? null : Number(v));

// ── lot lines on a bill / invoice ────────────────────────────────────

/** Each lot line of a purchase is a new lot in stores, at what the line puts into stock. */
async function buy(user, draft, lines, env) {
  const totals = computeTotals(draft);
  const atGross = vatTreatment(user, draft) === 'non_claimable'; // VAT that cannot be claimed back is part of the cost
  const rate = companyRate(user, draft);
  const codes = await outputCodes(user, lines.map(({ it }) => it.lot), { at: (n) => `items[${lines[n].i}].lot` });
  const supplier = await counterpartyName(user, draft);
  const outputs = lines.map(({ it, i }, n) => {
    const { lot } = it;
    const carats = lots.round3(lot.carats);
    if (!(carats > 0)) refuse(`items[${i}].lot needs the weight in carats. Ask the trader for it (1 gram = 5 carats).`);
    const line = totals.lines[i];
    const value = round2((atGross ? line.gross : line.net) * rate);
    if (!(value > 0)) refuse(`items[${i}].lot has no price: set price and pricing_basis as the trader said them. Ask the trader what was paid.`);
    const attrs = {};
    for (const k of BOUGHT) {
      if (!blank(lot[k])) attrs[k] = typeof lot[k] === 'string' ? lot[k].trim() : lot[k];
    }
    if (!lots.FORMS.includes(attrs.form)) refuse(`items[${i}].lot needs form (${lots.FORMS.join(', ')}). Ask the trader what was bought.`);
    const description = blank(lot.description) ? it.description : lot.description;
    if (!blank(description)) attrs.description = String(description).trim();
    if (PURCHASE_UNIT[lot.pricing_basis]) attrs.purchase_unit = PURCHASE_UNIT[lot.pricing_basis];
    if (supplier) attrs.supplier = supplier;
    if (lot.supplier_doc != null) attrs.supplier_doc = yes(lot.supplier_doc);
    if (lot.vat_exempt != null) attrs.vat_exempt = yes(lot.vat_exempt);
    const estimated = yes(lot.weight_estimated);
    if (estimated) env.warnings.push(`The weight of lot ${codes[n]} is an estimate. Re-weigh it when you can, so its cost per carat is right.`);
    return newOutput({
      code: codes[n], carats, pieces: count(lot.pieces), cost: value, item_kind: lots.itemKind(attrs.form), weight_estimated: estimated, line: i, attrs,
    });
  });
  return { ...blankOp(user, env), kind: 'buy', outputs, counterparty: supplier };
}

/** Each lot line of a sale takes from its lot at the lot's average cost, wherever the lot is. */
async function sell(user, draft, lines, env) {
  const codes = lines.map(({ it, i }) => lots.normCode(it.lot.code)
    || refuse(`items[${i}].lot needs the code of the lot being sold. Ask the trader which lot (query_lots lists them).`));
  const twice = codes.find((c, n) => codes.indexOf(c) !== n);
  if (twice) refuse(`Lot ${twice} is on two lines. Put each lot on one line.`);
  const rows = await store.getLots(user.id, codes);
  const inputs = lines.map(({ it }, n) => {
    const lot = rows.get(codes[n]);
    const input = take(lot, codes[n], it.lot, env);
    if (input.from === 'work') {
      refuse(`Lot ${lot.code} is ${held(lot)}: it cannot be sold from there. Record its return first (a move with direction return), then the sale.`);
    }
    return input;
  });
  return { ...blankOp(user, env), kind: 'sell', inputs, counterparty: await counterpartyName(user, draft) };
}

async function fromLotLines(user, draft, env) {
  const tt = draft.transaction_type || 'cash';
  const selling = tt === 'invoice_issued' || (tt === 'cash' && draft.direction === 'income');
  const buying = tt === 'bill_received' || (tt === 'cash' && draft.direction === 'expense');
  if (!selling && !buying) {
    refuse('Lots are bought on a bill and sold on an invoice. Set transaction_type=bill_received (buying) or invoice_issued (selling).');
  }
  env.date = opDate(user, draft.transaction_date);
  const lines = draft.items.map((it, i) => ({ it, i })).filter(({ it }) => it && it.lot && typeof it.lot === 'object');
  return selling ? sell(user, draft, lines, env) : buy(user, draft, lines, env);
}

// ── stock operations ─────────────────────────────────────────────────

const RETURN_FIRST = 'Record its return first (a move with direction return)';

/** Carats in against carats out of a split or merge: within the tolerance, the difference is a loss. */
function weightDifference(caratsIn, caratsOut, env, { what, of, hint = '' }) {
  const loss = lots.round3(caratsIn - caratsOut);
  const tolerance = cost.weightTolerance(caratsIn);
  if (Math.abs(loss) > tolerance + 1e-9) {
    refuse(`${what} ${ct(caratsOut)}, but ${ct(caratsIn)} ${of}: ${ct(Math.abs(loss))} ${loss > 0 ? 'short' : 'over'}, and the weights may differ by ${ct(tolerance)} at most. `
      + `Ask the trader to check the weights${hint}.`);
  }
  if (loss > 0) env.warnings.push(`${ct(loss)} is lost (${ct(caratsIn)} in, ${ct(caratsOut)} out).`);
  if (loss < 0) env.warnings.push(`${ct(-loss)} more comes out than went in (${ct(caratsIn)} in, ${ct(caratsOut)} out).`);
  return loss;
}

/** One lot (all of it, or a part) sorted into new lots in stores. */
async function split(user, sop, env) {
  if (!Array.isArray(sop.inputs) || sop.inputs.length !== 1) refuse('A split works on one lot at a time. Put one lot in stock_op.inputs.');
  const { inputs, rows } = await takeInputs(user, sop, env, { countPieces: false });
  const [input] = inputs;
  const [lot] = rows;
  if (lot.location !== 'stores') refuse(`Lot ${lot.code} is ${held(lot)}. ${RETURN_FIRST}, then split it.`);
  const lines = outputLines(sop);
  if (!lines.length) refuse('A split needs stock_op.outputs: the parts that came out, each with its carats. Ask the trader for the weights.');
  if (lines.length < 2 && input.whole) {
    refuse(`A split of the whole of lot ${lot.code} needs at least two parts. To take only part of it out, give carats on the input.`);
  }

  const caratsOut = lots.round3(sum(lines, (o) => o.carats));
  const loss = weightDifference(input.carats, caratsOut, env, {
    what: 'The parts weigh', of: `of lot ${lot.code} ${input.whole ? 'go' : 'goes'} in`,
    hint: input.whole ? ' (to take only part of the lot, give carats on the input)' : '',
  });

  // Counted stones: pieces out + damaged = pieces in. A part taken without a count is counted by its parts.
  const allCounted = lines.every((o) => !blank(o.pieces));
  const good = sum(lines, (o) => o.pieces);
  const damaged = sum(lines, (o) => o.damaged_pieces);
  const said = typeof sop.inputs[0] === 'object' ? sop.inputs[0].pieces : null;
  input.pieces = piecesTaken(lot, input.whole, blank(said) && !input.whole && lot.pieces != null && allCounted ? good + damaged : said, env);
  if (input.pieces != null) {
    if (!allCounted) refuse(`Lot ${lot.code} is counted (${pcs(input.pieces)} go in): every part needs its pieces. Ask the trader how many stones are in each part.`);
    if (good + damaged !== input.pieces) {
      refuse(`${pcs(input.pieces)} of lot ${lot.code} go in, but ${good + damaged} come out (${good} in the parts${damaged ? `, ${damaged} damaged` : ''}). `
        + 'Pieces out plus damaged must equal pieces in: ask the trader to count again.');
    }
  }

  const codes = await outputCodes(user, lines);
  const base = attrsOf(lot);
  const outputs = lines.map((o, i) => {
    const attrs = { ...base, ...statedAttrs(o) };
    if (lots.itemKind(attrs.form) !== lots.itemKind(lot.form)) {
      refuse(`A split only sorts stones: part ${i + 1} cannot be ${attrs.form} when lot ${lot.code} is ${lot.form || 'rough'}. Stones that were worked on are a transform (cutting, …).`);
    }
    return newOutput({
      code: codes[i], carats: lots.round3(o.carats), pieces: count(o.pieces), damaged_pieces: Number(o.damaged_pieces) || 0,
      item_kind: lots.itemKind(attrs.form), line: i, attrs,
    });
  });
  const op = { ...blankOp(user, env), kind: 'split', inputs, outputs, loss_carats: loss };
  shareCost(outputs, lines, input.cost, op.method);
  return op;
}

/** Several lots in stores, of the same kind, into one: a new lot, or one of them kept under its code. */
async function merge(user, sop, env) {
  const { inputs, rows } = await takeInputs(user, sop, env);
  if (inputs.length < 2) refuse('A merge needs at least two lots in stock_op.inputs. Ask the trader which lots go together.');
  const away = rows.find((l) => l.location !== 'stores');
  if (away) refuse(`Lot ${away.code} is ${held(away)}. ${RETURN_FIRST}, then put the lots together.`);
  const kind = lots.itemKind(rows[0].form);
  const odd = rows.find((l) => lots.itemKind(l.form) !== kind);
  if (odd) refuse(`Lot ${rows[0].code} is ${rows[0].form || 'rough'} and lot ${odd.code} is ${odd.form || 'rough'}: rough and cut stones cannot go into one lot.`);
  const given = Array.isArray(sop.outputs) ? sop.outputs : [];
  if (given.length > 1) refuse('A merge makes one lot: give one output.');
  const line = given[0] && typeof given[0] === 'object' ? given[0] : {};

  const caratsIn = lots.round3(sum(inputs, (x) => x.carats));
  const carats = blank(line.carats) ? caratsIn : lots.round3(line.carats);
  const loss = weightDifference(caratsIn, carats, env, { what: 'The merged lot is given as', of: 'go in' });

  // The output may carry the code of one of the lots going in: that lot is kept, the others end.
  const kept = blank(line.code) ? null : rows.find((l) => l.code === lots.normCode(line.code)) || null;
  if (kept && !inputs[rows.indexOf(kept)].whole) {
    refuse(`To put the stones into lot ${kept.code}, all of it goes in: leave carats out on that input, or leave the output code out for a new lot.`);
  }
  const [code] = await outputCodes(user, [line], { keep: kept ? [kept.code] : [], hint: ' To add stones to an existing lot, list that lot in inputs too.' });

  const attrs = { ...commonAttrs(rows), ...statedAttrs(line) };
  if (lots.itemKind(attrs.form) !== kind) refuse(`A merge only puts stones together: the result cannot be ${attrs.form} when the lots are ${rows[0].form || 'rough'}.`);
  if (attrs.treatment === lots.MIXED_TREATMENT) {
    env.warnings.push(`These lots have different treatments (${rows.map((l) => `${l.code}: ${l.treatment || 'not recorded'}`).join(', ')}). The merged lot is marked "mixed".`);
  }
  const counted = inputs.every((x) => x.pieces != null);
  const piecesIn = counted ? sum(inputs, (x) => x.pieces) : null;
  if (!blank(line.pieces) && piecesIn != null && Number(line.pieces) !== piecesIn) {
    refuse(`The lots hold ${pcs(piecesIn)} together, not ${line.pieces}. Ask the trader to count again, or leave pieces out.`);
  }
  const output = newOutput({
    code, carats, pieces: blank(line.pieces) ? piecesIn : Number(line.pieces), cost: round2(sum(inputs, (x) => x.cost)),
    item_kind: kind, weight_estimated: rows.some((l) => !!l.weight_estimated), line: given.length ? 0 : null, attrs: dropNulls(attrs),
  });
  if (kept) {
    // Only what changes on the kept lot is written; what the lots disagree on is cleared.
    const changed = Object.fromEntries(Object.entries(attrs).filter(([k, v]) => (kept[k] == null ? null : kept[k]) !== v));
    Object.assign(output, { new: false, lot_id: kept.id, revision: kept.revision, attrs: changed });
  }
  return { ...blankOp(user, env), kind: 'merge', inputs, outputs: [output], loss_carats: loss };
}

/** What a job changes about the stones, so it is not inherited from the lot that went in. */
const NOT_INHERITED = { cutting: ['shape', 'size', 'grade', 'description'], recut: ['size'] };

/**
 * Cutting, sawing, heating, preforming, a recut or a re-weigh: all the cost that goes in, plus the
 * part of the fee that goes into the stones, is on what comes out.
 */
async function transform(user, draft, sop, env, feeCapitalised) {
  const { job } = sop;
  if (!lots.JOBS.includes(job)) refuse(`A transform needs stock_op.job: ${lots.JOBS.join(', ')}. Ask the trader what was done to the stones.`);
  const word = JOB_WORDS[job];
  const { inputs, rows } = await takeInputs(user, sop, env);
  const lines = outputLines(sop);
  if (!lines.length) refuse('A transform needs stock_op.outputs: what came back, each with its carats. Ask the trader for the weights.');
  const away = rows.find((l) => l.location === 'memo' || (job === 'reweigh' && l.location !== 'stores'));
  if (away) refuse(`Lot ${away.code} is ${held(away)}. ${RETURN_FIRST}, then the ${word}.`);
  const [lot] = rows;
  const kind = lots.itemKind(lot.form);
  const odd = rows.find((l) => lots.itemKind(l.form) !== kind);
  if (odd) refuse(`Lot ${lot.code} is ${lot.form || 'rough'} and lot ${odd.code} is ${odd.form || 'rough'}: rough and cut stones are worked on separately. Record one ${word} for each.`);
  if (job === 'cutting' && kind === 'cut') refuse(`Lot ${lot.code} is already ${lot.form}. Cutting it again is job recut.`);
  if (job === 'recut' && kind !== 'cut') refuse(`Lot ${lot.code} is ${lot.form || 'rough'}, not cut: cutting it is job cutting, not recut.`);
  if (job === 'preform' && kind === 'cut') refuse(`Lot ${lot.code} is already ${lot.form}: it cannot be preformed. Ask the trader what was done to it.`);

  // A recut or re-weigh of one whole lot keeps the lot: same code, a new batch (revision + 1).
  const one = inputs.length === 1 && lines.length === 1;
  if (job === 'reweigh' && !(one && inputs[0].whole)) {
    refuse('A re-weigh corrects the weight of one whole lot: one lot in inputs (no carats) and one output with the weight found. To take part of a lot out, use a split.');
  }
  const keeps = (job === 'recut' || job === 'reweigh') && one && inputs[0].whole;
  if (keeps && !blank(lines[0].code) && lots.normCode(lines[0].code) !== lot.code) {
    refuse(`A ${word} of the whole lot keeps its code ${lot.code}. Remove the code ${lines[0].code} from the output.`);
  }

  const caratsIn = lots.round3(sum(inputs, (x) => x.carats));
  const caratsOut = lots.round3(sum(lines, (o) => o.carats));
  const loss = lots.round3(caratsIn - caratsOut);
  if (job !== 'reweigh' && -loss > cost.weightTolerance(caratsIn) + 1e-9) {
    refuse(`${ct(caratsOut)} came out of ${ct(caratsIn)}: more than went in. Ask the trader to check the weights. `
      + 'If the weight on record was wrong, correct it first with a re-weigh (job reweigh).');
  }

  const base = rows.length === 1 ? attrsOf(lot, { without: NOT_INHERITED[job] }) : dropNulls(commonAttrs(rows));
  if (rows.length > 1) (NOT_INHERITED[job] || []).forEach((k) => { delete base[k]; });
  if (base.treatment === lots.MIXED_TREATMENT) {
    env.warnings.push(`These lots have different treatments (${rows.map((l) => `${l.code}: ${l.treatment || 'not recorded'}`).join(', ')}). What comes out is marked "mixed".`);
  }
  const codes = keeps ? [lot.code] : await outputCodes(user, lines);
  const outputs = lines.map((o, i) => {
    const said = statedAttrs(o);
    const form = said.form || (job === 'cutting' ? 'cut' : job === 'preform' ? 'preform' : lot.form || 'rough');
    const itemKind = lots.itemKind(form);
    if (job !== 'cutting' && itemKind !== kind) {
      refuse(`A ${word} does not turn ${lot.form || 'rough'} stones into ${form}: output ${i + 1} stays ${kind === 'cut' ? 'cut' : 'rough or preform'}.`
        + `${kind === 'cut' ? '' : ' Stones that were cut are job cutting.'}`);
    }
    const same = {
      code: codes[i], carats: lots.round3(o.carats), damaged_pieces: Number(o.damaged_pieces) || 0, item_kind: itemKind, line: i,
      // Heating one lot into one, a recut or a re-weigh of a whole lot: the count stays unless another is said.
      pieces: blank(o.pieces) ? (keeps || (job === 'heating' && one && inputs[0].whole) ? inputs[0].pieces : null) : Number(o.pieces),
    };
    if (!keeps) return newOutput({ ...same, attrs: { ...base, ...said, form } });
    // The kept lot: only what the trader says changes; a recut makes the old size untrue.
    const attrs = { ...said };
    if (job === 'recut' && said.size === undefined && lot.size != null) attrs.size = null;
    return { ...newOutput(same), new: false, lot_id: lot.id, revision: lot.revision + 1, attrs };
  });

  const money = lots.hasMoney(draft);
  const capitalised = money ? Math.max(0, round2(Number(feeCapitalised) || 0)) : 0;
  const op = {
    ...blankOp(user, env), kind: 'transform', job, inputs, outputs,
    fee: money ? { amount: round2(draft.amount), capitalised, basis: blank(sop.fee_basis) ? null : sop.fee_basis } : null,
    yield_pct: cost.yieldPct(caratsIn, caratsOut), loss_carats: loss,
  };
  shareCost(outputs, lines, round2(sum(inputs, (x) => x.cost) + capitalised), op.method);

  env.warnings.push(...cost.yieldWarnings({ job, caratsIn, caratsOut }));
  if (job === 'recut') {
    for (const l of rows.filter((r) => FRAGILE.includes(r.treatment))) {
      env.warnings.push(`Lot ${l.code} is treated (${l.treatment}): a recut can remove or damage that treatment. Check the stones afterwards.`);
    }
  }
  if (job === 'heating' && lines.some((o, i) => blank(o.treatment) && ['none', 'unknown', undefined].includes(outputs[i].attrs.treatment))) {
    env.warnings.push('The treatment on record after this heating is not set. Say what it is now (for example H) so it is on the lot.');
  }
  op.holder = (blank(sop.holder) ? null : String(sop.holder).trim()) || commonHolder(rows) || (money ? await counterpartyName(user, draft) : null);
  return op;
}

/**
 * Stones going out for work or on memo, or coming back. A whole lot keeps its code and only
 * changes place; a part becomes a new lot at the destination and the rest stays where it was.
 */
async function move(user, sop, env) {
  const { direction } = sop;
  const to = DESTINATION[direction];
  if (!to) refuse(`A move needs stock_op.direction: ${lots.MOVE_DIRECTIONS.join(', ')}. Ask the trader where the stones went.`);
  const { inputs, rows } = await takeInputs(user, sop, env);
  const said = blank(sop.holder) ? null : String(sop.holder).trim();
  const op = { ...blankOp(user, env), kind: 'move', direction, inputs };

  if (direction === 'return') {
    const here = rows.find((l) => l.location === 'stores');
    if (here) refuse(`Lot ${here.code} is in stores: there is nothing to return. Ask the trader which lot came back (query_lots lists what is out).`);
    const names = [...new Set(rows.map((l) => l.holder || ''))];
    if (names.length > 1) refuse(`These lots are out with different people (${rows.map((l) => `${l.code}: ${l.holder || 'nobody on record'}`).join(', ')}). Record each return on its own.`);
    if (said && rows[0].holder && !sameName(said, rows[0].holder)) {
      refuse(`Lot ${rows[0].code} is ${held(rows[0])}, not with ${said}. Ask the trader who returned it.`);
    }
    op.holder = rows[0].holder || said;
  } else {
    const away = rows.find((l) => l.location !== 'stores');
    if (away) refuse(`Lot ${away.code} is already ${held(away)}. ${RETURN_FIRST}, then send it out again.`);
    if (!said) refuse(`A lot going out needs stock_op.holder: who has the stones. Ask the trader who lot ${rows[0].code} went to.`);
    op.holder = said;
    if (!blank(sop.due_date)) {
      const due = String(sop.due_date).trim();
      if (!ISO_DATE.test(due)) refuse(`The due date "${sop.due_date}" is not a date. Give it as YYYY-MM-DD.`);
      if (!isDay(due)) refuse(`The due date "${sop.due_date}" is not a day on the calendar. Ask the trader when the stones are due back.`);
      if (due < env.date) refuse(`The due date ${due} is before the day the stones went out (${env.date}). Ask the trader when they are due back.`);
      op.due_date = due;
    }
    if (direction === 'out_memo' && !blank(sop.memo_price_per_ct)) {
      const price = Number(sop.memo_price_per_ct);
      if (!(price > 0)) refuse(`The memo price "${sop.memo_price_per_ct}" is not a price per carat. Ask the trader what was agreed, or leave it out.`);
      op.memo_price_per_ct = price;
    }
  }

  // The draft of a move has no outputs, so a code assigned here is assigned again, the same, at save time.
  const next = await store.nextCodes(user.id, inputs.filter((x) => !x.whole).length);
  op.outputs = inputs.map((x, i) => {
    const lot = rows[i];
    const same = { carats: x.carats, cost: x.cost, to, item_kind: lots.itemKind(lot.form), weight_estimated: !!lot.weight_estimated };
    if (!x.whole) return newOutput({ code: next.shift(), pieces: x.pieces, ...same, attrs: attrsOf(lot) });
    return { ...newOutput({ code: lot.code, pieces: lot.pieces, ...same }), new: false, lot_id: lot.id, revision: lot.revision };
  });
  return op;
}

/** Stones lost, stolen, broken or given away: they leave the books at their cost. */
async function writeOff(user, sop, env) {
  if (blank(sop.reason)) refuse('A write-off needs stock_op.reason: what happened to the stones (lost, broken, stolen, a gift, …). Ask the trader.');
  const { inputs } = await takeInputs(user, sop, env);
  return {
    ...blankOp(user, env), kind: 'write_off', inputs, loss_carats: lots.round3(sum(inputs, (x) => x.carats)), reason: String(sop.reason).trim(),
  };
}

const STOCK_OPS = ['split', 'merge', 'transform', 'move', 'write_off'];

async function resolve(user, draft, { feeCapitalised = 0 } = {}) {
  if (!draft || typeof draft !== 'object') refuse('There is no draft to work out.');
  const lotLines = lots.hasLotLines(draft);
  const stockOp = lots.hasStockOp(draft);
  if (lotLines && stockOp) {
    refuse('A stock operation and a purchase or sale of lots need separate confirmations. Record the bill or invoice first, then the stock operation.');
  }
  if (!lotLines && !stockOp) refuse('This draft does nothing to a lot: it has no lot lines and no stock_op.');
  const env = { warnings: [], date: null };
  if (lotLines) return fromLotLines(user, draft, env);

  const sop = draft.stock_op;
  if (!STOCK_OPS.includes(sop.kind)) {
    refuse(sop.kind === 'undo'
      ? 'An undo is not worked out here: it reverses a recorded operation as it stands.'
      : `stock_op.kind must be one of ${STOCK_OPS.join(', ')}.`);
  }
  env.date = opDate(user, sop.date);
  if (sop.kind !== 'transform' && Number(draft.amount) > 0) {
    refuse(`Only a transform (cutting, heating, …) carries a fee; a ${sop.kind.replace('_', '-')} moves no money. Set amount to 0 and record the cost as its own expense.`);
  }
  let op;
  if (sop.kind === 'split') op = await split(user, sop, env);
  else if (sop.kind === 'merge') op = await merge(user, sop, env);
  else if (sop.kind === 'transform') op = await transform(user, draft, sop, env, feeCapitalised);
  else if (sop.kind === 'move') op = await move(user, sop, env);
  else op = await writeOff(user, sop, env);
  op.note = blank(sop.note) ? null : String(sop.note).trim();
  return op;
}

/**
 * @param {object} user
 * @param {object} draft  after draft.prepare
 * @param {{feeCapitalised?: number}} [opts]  the part of the fee that goes into the stones (company
 *   currency, 2 dp), worked out by the caller from the bill it will post; 0 when there is no fee
 * @returns {Promise<{ok: true, op: object}|{ok: false, error: string}>}  op is a ResolvedOp (index.js)
 */
async function resolveDraft(user, draft, opts = {}) {
  try {
    return { ok: true, op: await resolve(user, draft, opts) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.message };
    throw err;
  }
}

module.exports = { resolveDraft };
