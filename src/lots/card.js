/**
 * The confirmation card of a lot draft: what the trader reads before saying yes.
 *
 * Built from the ResolvedOp, never from the model's words: every carat, piece count and cost on
 * it is what will be saved. Same shape as tools/card.js buildCard: { lines: string[], ... }.
 *
 *   buy / sell   the money card (tools/card.js) with one line per lot instead of the item lines
 *   stock ops    a title in the trader's words, what goes in, what comes out, where it is, the
 *                yield, the fee and where it goes, then the ⚠ lines
 *
 * Deterministic: the same draft and op always give the same lines. Costs are in the company
 * currency (what the lot carries in stock); a sale price is in the invoice's currency.
 */
const lots = require('./index');
const { round2, companyCurrency } = require('../erp-sync/common');
const { buildCard, fmt, isoToCard, WARNING_HEADER } = require('../tools/card');

const JOB_TITLES = { cutting: 'Cutting', sawing: 'Sawing', heating: 'Heating', preform: 'Preforming', recut: 'Recut', reweigh: 'Re-weigh' };
const MOVE_TITLES = { out_work: 'Send out for work', out_memo: 'Send out on memo', return: 'Stones returned' };
const KIND_TITLES = { split: 'Sort / split a lot', merge: 'Merge lots', transform: 'Work on stones', move: 'Move stones', write_off: 'Write off stones' };
const BASIS_WORDS = { per_g: 'per g', per_kg: 'per kg', per_piece: 'per piece' };

/** 120 → "120"; 5.5 → "5.5"; 1234.125 → "1,234.125" (carats: up to 3 decimals, no padding). */
const ct = (n) => Number(lots.round3(n)).toLocaleString('en-US', { maximumFractionDigits: 3 });
const perCt = (amount, carats) => (Number(carats) > 0 ? fmt(round2(Number(amount) / Number(carats))) : null);

function title(op) {
  if (op.kind === 'transform' && JOB_TITLES[op.job]) return JOB_TITLES[op.job];
  if (op.kind === 'move' && MOVE_TITLES[op.direction]) return MOVE_TITLES[op.direction];
  return KIND_TITLES[op.kind] || String(op.kind);
}

/** "blue sapphire rough" from a lot's attributes, when nobody described it. */
const describe = (a) => [a.colour, a.variety || a.species, a.form].filter(Boolean).join(' ');
const label = (code, words) => [code, words].filter(Boolean).join(' ');
/** The words for a lot as it was read (inputs[].before): its description, else what its attributes say. */
const wordsOf = (b) => (b && (b.description || describe(b))) || '';

/**
 * What the lot will carry beyond its name, so everything that is saved is on the card: colour,
 * variety, species or form when the name does not already say them, shape, size, clarity, grade,
 * origin, the treatment and who says so, the VAT exemption and the supplier document. One line
 * under the lot's own, or nothing when there is nothing more to say.
 */
function detailLines(attrs, name = '') {
  const a = attrs || {};
  const known = String(name).toLowerCase();
  const bits = [];
  for (const k of ['colour', 'variety', 'species', 'form']) {
    if (a[k] != null && !known.includes(String(a[k]).toLowerCase())) bits.push(`${k} ${a[k]}`);
  }
  for (const k of ['shape', 'size', 'clarity', 'grade', 'origin']) if (a[k] != null) bits.push(`${k} ${a[k]}`);
  if (a.treatment != null) bits.push(`treatment ${a.treatment}${a.treatment_source ? ` (source: ${a.treatment_source})` : ''}`);
  else if (a.treatment_source) bits.push(`treatment source: ${a.treatment_source}`);
  if (a.vat_exempt != null) bits.push(a.vat_exempt ? 'VAT-exempt purchase (uncut stones)' : 'not VAT-exempt');
  if (a.supplier_doc != null) bits.push(`supplier document: ${a.supplier_doc ? 'yes' : 'no'}`);
  return bits.length ? [`  Details: ${bits.join(', ')}`] : [];
}

/** " (out for work with Lek since 2026/11/02)" for a lot that is not in the office. */
function whereNow(input) {
  if (input.from !== 'work' && input.from !== 'memo') return '';
  const b = input.before || {};
  const since = b.last_op_date ? ` since ${isoToCard(b.last_op_date)}` : '';
  return ` (${input.from === 'work' ? 'out for work' : 'on memo'}${b.holder ? ` with ${b.holder}` : ''}${since})`;
}

/** "5.5 ct of 8 ct" when only part of the lot is taken. */
function taken(input) {
  const b = input.before || {};
  const part = !input.whole && b.carats != null && lots.round3(b.carats) !== lots.round3(input.carats);
  return `${ct(input.carats)} ct${part ? ` of ${ct(b.carats)} ct` : ''}`;
}

/** "- L13 blue sapphire rough: 120 ct, cost 270,000 THB (out for work with Lek since 2026/11/02)" */
function inputLine(input, currency, tail = '') {
  const b = input.before || {};
  const bits = [taken(input)];
  if (input.pieces != null) bits.push(`${input.pieces} pcs`);
  bits.push(`cost ${fmt(input.cost)} ${currency}`);
  return `- ${label(input.code, wordsOf(b))}: ${bits.join(', ')}${whereNow(input)}${tail}`;
}

/** "30 ct, 42 pcs, cost 272,400 THB = 9,080 per ct" */
function outputBits(out, currency) {
  const bits = [`${ct(out.carats)} ct${out.weight_estimated ? ' (estimated)' : ''}`];
  if (out.pieces != null) bits.push(`${out.pieces} pcs`);
  if (Number(out.damaged_pieces) > 0) bits.push(`${out.damaged_pieces} pcs damaged`);
  const each = perCt(out.cost, out.carats);
  bits.push(`cost ${fmt(out.cost)} ${currency}${each ? ` = ${each} per ct` : ''}`);
  return bits.join(', ');
}

/** A lot that is kept (a re-weigh, a recut, a merge into one) carries only what changes: it keeps its own words. */
function outputLine(out, currency, inputs = []) {
  const a = out.attrs || {};
  const kept = out.new === false ? inputs.find((i) => i.code === out.code) : null;
  const words = a.description || (kept && wordsOf(kept.before)) || describe(a);
  return [`- ${label(out.code, words)}: ${outputBits(out, currency)}`, ...detailLines(a, words)];
}

/** The ⚠ block: the draft's warnings (the gate has put op.warnings among them), each once. */
function warningLines(draft, op) {
  const seen = new Set();
  const all = [...(Array.isArray(draft.trust_warnings) ? draft.trust_warnings : []), ...(op.warnings || [])]
    .filter((w) => w && !seen.has(w) && seen.add(w));
  return all.length ? [WARNING_HEADER, ...all.map((w) => `- ${w}`)] : [];
}

/** Bill or invoice with lot lines: the money card, each lot on a line of its own. */
async function moneyCard(user, draft, op, getErp) {
  const currency = companyCurrency(user);
  const selling = op.kind === 'sell';
  const several = (draft.items || []).length > 1;
  const lineFor = (it, i) => {
    const lot = it && it.lot;
    if (!lot || typeof lot !== 'object') return null;
    const total = several ? ` = ${fmt(it.rate)}` : '';
    if (selling) {
      const input = (op.inputs || []).find((x) => x.code === lot.code);
      const bits = [input ? `${taken(input)}${input.whole ? ' (the whole lot, none left)' : ''}` : `${ct(lot.carats)} ct`];
      const pieces = input && input.pieces != null ? input.pieces : lot.pieces;
      if (pieces != null) bits.push(`${pieces} pcs`);
      const words = (input && wordsOf(input.before)) || it.description;
      // The price as the trader said it, and the price per carat worked out from it when it was not said that way.
      const each = perCt(it.rate, lot.carats);
      let price = `@ ${each} per ct${total}`;
      if (lot.pricing_basis === 'total') price = `for ${fmt(it.rate)} (${each} per ct)`;
      else if (lot.pricing_basis === 'per_piece') price = `@ ${fmt(lot.price)} per piece (${each} per ct)${total}`;
      return `- ${label(lot.code, words)}: ${bits.join(', ')} ${price}${input ? whereNow(input) : ''}`;
    }
    const out = (op.outputs || []).find((x) => x.line === i) || (op.outputs || []).find((x) => x.code === lot.code);
    const stated = BASIS_WORDS[lot.pricing_basis] ? ` (${fmt(lot.price)} ${BASIS_WORDS[lot.pricing_basis]})` : '';
    if (!out) return `- ${label(lot.code, it.description)}: ${ct(lot.carats)} ct @ ${perCt(it.rate, lot.carats)} per ct${stated}`;
    const a = out.attrs || {};
    const words = a.description || it.description || describe(a);
    return [`- ${label(out.code, words)}: ${outputBits(out, currency)}${stated}`, ...detailLines(a, words)];
  };
  const card = await buildCard(user, draft, getErp, { lineFor });
  // A direct caller's op.warnings that are not on the draft yet still show, once.
  const all = warningLines(draft, op);
  const lines = [...card.lines.slice(0, card.lines.length - card.warning_lines.length), ...all];
  return { ...card, warning_lines: all, lines };
}

/** "Fee: 2,400 THB (80 × 30 ct)" and the rest of the fee's money card, without its date and ⚠ lines. */
async function feeLines(user, draft, op, getErp) {
  const currency = companyCurrency(user);
  const card = await buildCard(user, draft, getErp);
  const so = draft.stock_op || {};
  let quoted = '';
  if (Number(so.fee_rate) > 0 && so.fee_basis === 'per_ct') {
    quoted = ` (${fmt(so.fee_rate)} × ${ct((op.outputs || []).reduce((s, o) => s + Number(o.carats), 0))} ct)`;
  } else if (Number(so.fee_rate) > 0 && so.fee_basis === 'per_piece') {
    quoted = ` (${fmt(so.fee_rate)} × ${(op.outputs || []).reduce((s, o) => s + (Number(o.pieces) || 0), 0)} pcs)`;
  }
  const body = card.lines
    .slice(1, card.lines.length - card.warning_lines.length)
    .map((l) => (l === card.amount_line ? `${l.replace(/^Amount:/, 'Fee:')}${quoted}` : l));
  const into = op.fee && Number(op.fee.capitalised) > 0
    ? (round2(op.fee.capitalised) === round2(op.fee.amount)
      ? 'The fee goes into the cost of the stones.'
      : `Into the cost of the stones: ${fmt(op.fee.capitalised)} ${currency} of the fee`)
    : 'The fee does not go into the cost of the stones.';
  return [...body, into];
}

/** Split, merge, cutting and the other jobs: what goes in, what comes out. */
async function makeLines(user, draft, op, getErp) {
  const currency = companyCurrency(user);
  const lines = ['From:', ...(op.inputs || []).map((i) => inputLine(i, currency)), 'To:', ...(op.outputs || []).flatMap((o) => outputLine(o, currency, op.inputs || []))];
  const loss = lots.round3(op.loss_carats || 0);
  if (op.kind === 'transform' && op.job !== 'reweigh' && op.yield_pct != null) {
    lines.push(`Yield: ${Number(op.yield_pct).toFixed(1)}%${loss > 0 ? ` (${ct(loss)} ct lost)` : ''}`);
  } else if (loss !== 0) {
    lines.push(`Weight difference: ${loss > 0 ? `${ct(loss)} ct lost` : `${ct(-loss)} ct more than went in`}`);
  }
  if ((op.outputs || []).length > 1 && (op.kind === 'split' || op.kind === 'transform')) {
    lines.push(`Cost shared by ${op.method === 'weight' ? 'weight' : 'value (your figures)'}`);
  }
  if (op.kind === 'transform') {
    if (op.fee && Number(op.fee.amount) > 0 && lots.hasMoney(draft)) lines.push(...await feeLines(user, draft, op, getErp));
    else if (op.job !== 'reweigh') lines.push('Fee: none');
  }
  return lines;
}

/** Stones going out to a cutter or on memo, or coming back unchanged. */
function moveLines(user, draft, op) {
  const currency = companyCurrency(user);
  const ins = op.inputs || [];
  const outs = op.outputs || [];
  const paired = ins.length === outs.length;
  const back = op.direction === 'return';
  const holder = op.holder || (ins[0] && ins[0].before && ins[0].before.holder) || null;
  const lines = [];
  if (holder) lines.push(`${back ? 'From' : 'To'}: ${holder}`);
  lines.push(...ins.map((i, n) => inputLine(i, currency, paired && outs[n].code !== i.code ? ` → new lot ${outs[n].code}` : '')));
  if (!paired) {
    lines.push(...outs.filter((o) => o.new).flatMap((o) => {
      const [first, ...more] = outputLine(o, currency);
      return [`New lot: ${first.slice(2)}`, ...more];
    }));
  }
  if (op.memo_price_per_ct != null) {
    const carats = ins.reduce((s, i) => s + Number(i.carats), 0);
    lines.push(`Memo price: ${fmt(op.memo_price_per_ct)} per ct = ${fmt(round2(op.memo_price_per_ct * carats))} ${draft.currency || currency}`);
  }
  if (op.due_date) lines.push(`Due back: ${isoToCard(op.due_date)}`);
  if (back) lines.push('Back in stock.');
  return lines;
}

function writeOffLines(user, op) {
  const currency = companyCurrency(user);
  const ins = op.inputs || [];
  const lines = ins.map((i) => inputLine(i, currency));
  if (op.reason) lines.push(`Reason: ${op.reason}`);
  lines.push(`Loss: ${fmt(ins.reduce((s, i) => s + Number(i.cost), 0))} ${currency} leaves stock`);
  return lines;
}

/**
 * @param {object} user
 * @param {object} draft   prepared; trust_warnings (⚠ lines, already including op.warnings) are on it
 * @param {object} op      ResolvedOp
 * @param {() => object} getErp
 * @returns {Promise<{lines: string[]}>}  buy / sell: the money card (tools/card.js) with one line
 *   per lot instead of item lines; stock operations: what goes in, what comes out, where it is,
 *   the fee and where it goes, the yield, then the ⚠ lines
 */
async function build(user, draft, op, getErp) {
  if (op.kind === 'buy' || op.kind === 'sell') return moneyCard(user, draft, op, getErp);

  const lines = [title(op), `Date: ${isoToCard(op.date)}`];
  if (op.kind === 'move') lines.push(...moveLines(user, draft, op));
  else if (op.kind === 'write_off') lines.push(...writeOffLines(user, op));
  else lines.push(...await makeLines(user, draft, op, getErp));
  // A fee's own note is on its money lines already (the draft's description).
  const note = op.note || (draft.stock_op && draft.stock_op.note) || null;
  if (note) lines.push(`Note: ${note}`);
  const warning_lines = warningLines(draft, op);
  lines.push(...warning_lines);
  return { lines, warning_lines };
}

module.exports = { build };
