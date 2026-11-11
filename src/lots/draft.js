/**
 * The lot part of a chat draft: normalise it and say what is wrong with it, before anything is
 * resolved or shown.
 *
 * prepare runs for the card and again for the save, on the same draft object, and the result is
 * signed: it MUST be idempotent (a prepared draft comes out unchanged), and so must the round
 * prepare → applyDefaults → prepare (the gate runs prepare before applyDefaults at the card and
 * after the card's applyDefaults at the save): whatever the second run would refuse, the first
 * must already refuse. The signature is a
 * JSON.stringify of the draft, so key ORDER inside a lot block or the stock_op counts too: the
 * nested objects are changed in place (existing keys assigned, blank ones deleted), never rebuilt.
 *
 * What is checked here is shape only: is every figure there, positive and of the right kind.
 * Whether a lot exists, holds enough carats, or the weights add up is the resolver's business.
 * Every message is an instruction to the chat model: what is wrong and what to ask the trader.
 */
const lots = require('./index');
const store = require('./store');
const { round2 } = require('../erp-sync/common');
const { amountFromPaidAfterWht } = require('../erp-sync/taxes');
const { localClock } = require('../jobs');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Today on the user's own clock (their timezone, else Asia/Bangkok), like the rest of the app's day-by-day work. */
const today = (user) => localClock(new Date(), user && user.timezone).date;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const show = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

const CT_UNIT = 'ct|cts|carat|carats';
const PC_UNIT = 'pc|pcs|piece|pieces|stone|stones';
/**
 * The one strict reading of a figure, used by every lot tool: a finite number, or a clean numeric
 * string ("30", "1,000", "30 ct" when `unit` allows "ct"). Anything else (true, an array, Infinity,
 * "abc", "1,5") is null, never a guess.
 */
function figure(v, unit = null) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = new RegExp(`^\\s*([+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|[+-]?\\.\\d+)${unit ? `\\s*(?:${unit})?` : ''}\\s*$`, 'i').exec(v);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
const positive = (v, unit) => { const n = figure(v, unit); return n !== null && n > 0; };
const whole = (v, unit) => { const n = figure(v, unit); return n !== null && Number.isInteger(n); };
/** Words: a string, or a number typed as one (a size "5"); null for anything else (an object would read "[object Object]"). */
function plain(v) {
  if (typeof v === 'string') return v.trim();
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
}
/** true / false, or "true" / "false" typed as words; null for anything else. */
function flag(v) {
  if (typeof v === 'boolean') return v;
  const w = typeof v === 'string' ? v.trim().toLowerCase() : null;
  return w === 'true' ? true : w === 'false' ? false : null;
}

const NEVER_GUESS = 'Never guess it.';
const BAD_CODE = 'cannot be a lot code (letters, digits, "-", "/" or ".", at most 20 characters)';

/** Blank values go (so "" and null mean "not said"); words lose their outer spaces. In place. Returns the problem or null. */
function tidy(obj, keys, at) {
  for (const k of keys) {
    if (!(k in obj)) continue;
    if (blank(obj[k])) { delete obj[k]; continue; }
    const text = plain(obj[k]);
    if (text === null) return `${at}.${k} must be a word or a few words, not ${show(obj[k])}. Ask the trader, or leave it out.`;
    obj[k] = text;
  }
  return null;
}

/** true / false flags: "false" and "true" as words are read, anything else is refused. In place. */
function flagProblem(obj, keys, at) {
  for (const k of keys) {
    if (!(k in obj)) continue;
    if (blank(obj[k])) { delete obj[k]; continue; }
    const f = flag(obj[k]);
    if (f === null) return `${at}.${k} must be true or false, not ${show(obj[k])}.`;
    obj[k] = f;
  }
  return null;
}

/** The list's own spelling of a value given in any case ("h-fh" → "H-FH"); null when not on it (or not text). */
function optionOf(value, options) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return options.find((o) => o.toLowerCase() === v) || null;
}

/** Carats / pieces on a lot line, an input or an output. Returns the problem or null. In place. */
function quantityProblem(obj, at, { caratsRequired }) {
  if (blank(obj.carats)) {
    delete obj.carats;
    if (caratsRequired) return `${at} needs the weight in carats. Ask the trader for it (1 gram = 5 carats). ${NEVER_GUESS}`;
  } else {
    if (!positive(obj.carats, CT_UNIT) || !(lots.round3(figure(obj.carats, CT_UNIT)) > 0)) return `${at}.carats ${show(obj.carats)} must be more than 0. Ask the trader for the weight.`;
    obj.carats = lots.round3(figure(obj.carats, CT_UNIT));
  }
  if (blank(obj.pieces)) delete obj.pieces;
  else if (!positive(obj.pieces, PC_UNIT) || !whole(obj.pieces, PC_UNIT)) return `${at}.pieces ${show(obj.pieces)} must be a whole number of stones. Leave it out when the stones were not counted.`;
  else obj.pieces = figure(obj.pieces, PC_UNIT);
  return null;
}

/** form / treatment from the lists, in the list's spelling. In place. */
function attributeProblem(obj, at) {
  if (blank(obj.form)) delete obj.form;
  else {
    const form = optionOf(obj.form, lots.FORMS);
    if (!form) return `${at}.form "${show(obj.form)}" is not one of ${lots.FORMS.join(', ')}. Ask the trader which it is.`;
    obj.form = form;
  }
  if (blank(obj.treatment)) delete obj.treatment;
  else {
    const treatment = optionOf(obj.treatment, lots.TREATMENTS);
    if (!treatment) return `${at}.treatment "${show(obj.treatment)}" is not one of ${lots.TREATMENTS.join(', ')} (unknown when the trader does not know).`;
    obj.treatment = treatment;
  }
  return null;
}

const LOT_TEXT = ['species', 'variety', 'shape', 'size', 'colour', 'clarity', 'origin', 'grade', 'description', 'treatment_source'];
const LOT_FLAGS = ['weight_estimated', 'supplier_doc', 'vat_exempt'];
const describe = (o) => [o.colour, o.variety || o.species, o.form].filter(Boolean).join(' ');

/** The line total from the price as the trader said it. One gram is five carats. */
function lineTotal(lot) {
  const price = lot.price;
  switch (lot.pricing_basis) {
    case 'per_ct': return round2(price * lot.carats);
    case 'per_g': return round2((price * lot.carats) / lots.CARATS_PER_GRAM);
    case 'per_kg': return round2((price * lot.carats) / (lots.CARATS_PER_GRAM * 1000));
    case 'per_piece': return round2(price * lot.pieces);
    default: return round2(price);
  }
}

/** What an invoice line for a lot being sold is called when the model gave no description. */
async function soldDescription(user, code) {
  try {
    const row = await store.getLot(user.id, code);
    if (row) return row.description || describe(row) || `Lot ${code}`;
  } catch (err) {
    console.error('[lots] description lookup failed:', err.message);
  }
  return `Lot ${code}`;
}

/** A sale line with no carats sells the whole lot: its weight (and count) is read from the lot. Returns the problem or null. */
async function wholeLotSale(user, lot, at) {
  const row = await store.getLot(user.id, lot.code);
  if (!row) return `${at}: lot ${lot.code} is not on record for this account. Check the code with the trader (query_lots lists the lots).`;
  if (row.status !== 'active' || !(lots.round3(row.carats) > 0)) return `${at}: lot ${lot.code} is empty, nothing is left to sell. Ask the trader which lot they mean.`;
  lot.carats = lots.round3(row.carats);
  if (lot.pricing_basis === 'per_piece' && !lot.pieces && row.pieces != null) lot.pieces = row.pieces;
  return null;
}

/** draft.items[].lot: a lot bought on a bill or sold on an invoice. */
async function prepareLotLines(user, draft) {
  const tt = draft.transaction_type;
  if (tt !== 'bill_received' && tt !== 'invoice_issued') {
    return 'Lots are bought on a bill and sold on an invoice, never as a plain cash entry or a payment. '
      + 'Set transaction_type=bill_received (buying) or invoice_issued (selling). Paid on the spot → payment_terms=net_0, save, then log the payment against it.';
  }
  const selling = tt === 'invoice_issued';
  if (blank(draft.direction)) draft.direction = selling ? 'income' : 'expense';
  // Stones bought for resale; without this the fallback category would be Other Expenses.
  if (!selling && blank(draft.category_code)) draft.category_code = '5000';

  const seen = new Set();
  for (const [i, it] of draft.items.entries()) {
    if (!it || it.lot == null) continue;
    const at = `items[${i}].lot`;
    const { lot } = it;
    if (!isObject(lot)) return `${at} must be an object: { ${selling ? 'code, carats' : 'carats, form, species'}, price, pricing_basis, … }.`;
    if (it.item_code) return `items[${i}] has both lot and item_code. A lot line carries only the lot block: remove item_code (it is for single stones kept by the piece).`;

    if (blank(lot.code)) {
      delete lot.code;
      if (selling) return `${at} needs the code of the lot being sold. Ask the trader which lot (query_lots lists them). ${NEVER_GUESS}`;
    } else {
      const code = lots.normCode(plain(lot.code));
      if (!code) return `${at}.code "${show(lot.code)}" ${BAD_CODE}. Ask the trader for the code${selling ? '' : ', or leave it out and one is assigned'}.`;
      if (seen.has(code)) return `Lot ${code} is on two lines. Put each lot on one line.`;
      seen.add(code);
      lot.code = code;
    }

    // A sale may leave the weight out: that is the whole lot (read below, once the price basis is known).
    const quantity = quantityProblem(lot, at, { caratsRequired: !selling });
    if (quantity) return quantity;
    const attribute = attributeProblem(lot, at);
    if (attribute) return attribute;
    const words = tidy(lot, LOT_TEXT, at) || tidy(it, ['description'], `items[${i}]`) || flagProblem(lot, LOT_FLAGS, at);
    if (words) return words;
    if (!selling) {
      if (!lot.form) return `${at} needs form (${lots.FORMS.join(', ')}). Ask the trader what was bought.`;
      if (!lot.species && !lot.variety && !lot.description && !it.description) {
        return `${at} needs to say what the stones are: species (e.g. corundum), variety (e.g. sapphire) or a description. Ask the trader.`;
      }
    }

    // The price as the trader said it; the line total is worked out here, never by the model.
    if (!positive(lot.price) || blank(lot.pricing_basis) || !optionOf(lot.pricing_basis, lots.PRICING_BASES)) {
      return `${at} needs price and pricing_basis (${lots.PRICING_BASES.join(', ')}) as the trader said them: e.g. price 1500 with pricing_basis per_ct, `
        + 'or the whole sum with pricing_basis total. The line total is worked out for you, so do not put it in rate. No price said → ask the trader.';
    }
    lot.price = figure(lot.price);
    lot.pricing_basis = optionOf(lot.pricing_basis, lots.PRICING_BASES);
    if (selling && ['per_g', 'per_kg'].includes(lot.pricing_basis)) {
      return `${at}: a sale is priced per_ct, per_piece or total, not ${lot.pricing_basis}. Ask the trader for the price per carat or the whole sum.`;
    }
    if (selling && lot.carats == null) {
      const empty = await wholeLotSale(user, lot, at);
      if (empty) return empty;
    }
    if (lot.pricing_basis === 'per_piece' && !lot.pieces) return `${at} is priced per piece, so it needs pieces (how many stones). Ask the trader.`;
    const total = lineTotal(lot);
    if (!(total > 0)) return `${at}: ${lot.price} ${lot.pricing_basis} on ${lot.carats} ct comes to less than 0.01. Check the price and the weight with the trader.`;

    const description = it.description || lot.description || (selling ? await soldDescription(user, lot.code) : describe(lot));
    draft.items[i] = { description, qty: 1, rate: total, lot };
  }
  return null;
}

const KIND_WORDS = 'split (sort a lot into grades, or take part of it out), merge (put lots together), '
  + 'transform (cutting, sawing, heating, preform, recut, reweigh), move (out for work, out on memo, back), write_off (lost or broken), undo';
const OUTPUT_TEXT = ['grade', 'shape', 'size', 'colour', 'clarity', 'description'];
const OP_TEXT = ['holder', 'due_date', 'reason', 'note', 'date'];
const UNDO_KEYS = ['kind', 'reference', 'lot'];

function prepareUndo(draft, op) {
  const extra = Object.keys(op).filter((k) => !UNDO_KEYS.includes(k) && !blank(op[k]) && !(Array.isArray(op[k]) && !op[k].length));
  if (extra.length) return `An undo names only the operation to take back (reference) or the lot whose newest operation to take back (lot). Remove ${extra.join(', ')} from stock_op.`;
  if (lots.hasMoney(draft) || (Array.isArray(draft.items) && draft.items.length)) {
    return 'An undo carries no money and no items. Finish or cancel the current draft first (cancel_transaction), then set the undo on its own.';
  }
  // Neither said: the newest operation (the undo card names it before anything is taken back).
  const words = tidy(op, ['reference', 'lot'], 'stock_op');
  if (words) return words;
  if (op.reference) op.reference = op.reference.toUpperCase();
  if (op.lot) {
    const code = lots.normCode(op.lot);
    if (!code) return `stock_op.lot "${op.lot}" ${BAD_CODE}. Ask the trader which lot.`;
    op.lot = code;
  }
  return null;
}

function prepareInputs(op) {
  if (!Array.isArray(op.inputs) || !op.inputs.length) {
    return `stock_op.inputs must list the lot(s) this is done to, e.g. [{ lot: "L12" }] (add carats only when part of the lot is taken). Ask the trader which lot. ${NEVER_GUESS}`;
  }
  const seen = new Set();
  for (const [i, raw] of op.inputs.entries()) {
    if (typeof raw === 'string') op.inputs[i] = { lot: raw };
    const inp = op.inputs[i];
    const at = `stock_op.inputs[${i}]`;
    if (!isObject(inp)) return `${at} must be { lot, carats?, pieces? }.`;
    if (blank(inp.lot) && !blank(inp.code)) inp.lot = inp.code;
    if ('code' in inp) delete inp.code;
    if (blank(inp.lot)) return `${at} needs the lot code. Ask the trader which lot (query_lots lists them). ${NEVER_GUESS}`;
    const code = lots.normCode(plain(inp.lot));
    if (!code) return `${at}.lot "${show(inp.lot)}" ${BAD_CODE}. Ask the trader for the code.`;
    if (seen.has(code)) return `Lot ${code} is listed twice in stock_op.inputs. List each lot once.`;
    seen.add(code);
    inp.lot = code;
    const quantity = quantityProblem(inp, at, { caratsRequired: false });
    if (quantity) return quantity;
  }
  return null;
}

/** A merge of whole lots is the sum of what goes in: worked out here, never by the model. */
async function fillMergeOutput(user, op) {
  if (!Array.isArray(op.outputs) || !op.outputs.length) op.outputs = [{}];
  const out = op.outputs[0];
  if (op.outputs.length !== 1 || !isObject(out) || !blank(out.carats)) return null;
  let carats = 0;
  for (const inp of op.inputs) {
    if (inp.carats) carats += inp.carats;
    else {
      const row = await store.getLot(user.id, inp.lot);
      if (!row) return `Lot ${inp.lot} is not on record (query_lots lists the lots). Ask the trader which lots to put together.`;
      carats += Number(row.carats);
    }
  }
  out.carats = lots.round3(carats);
  return null;
}

function prepareOutputs(user, op) {
  const seen = new Set();
  const byValue = lots.costMethod(user) === 'value' && ['split', 'transform'].includes(op.kind) && op.outputs.length > 1;
  for (const [i, out] of op.outputs.entries()) {
    const at = `stock_op.outputs[${i}]`;
    if (!isObject(out)) return `${at} must be { carats, pieces?, code?, value_per_ct?, form?, … }.`;
    if (blank(out.code)) delete out.code;
    else {
      const code = lots.normCode(plain(out.code));
      if (!code) return `${at}.code "${show(out.code)}" ${BAD_CODE}. Ask the trader for the code, or leave it out and one is assigned.`;
      if (seen.has(code)) return `Lot ${code} is given to two outputs. Each output is its own lot.`;
      seen.add(code);
      out.code = code;
    }
    const quantity = quantityProblem(out, at, { caratsRequired: true });
    if (quantity) return quantity;
    if (blank(out.damaged_pieces)) delete out.damaged_pieces;
    else if (!whole(out.damaged_pieces, PC_UNIT) || figure(out.damaged_pieces, PC_UNIT) < 0) return `${at}.damaged_pieces ${show(out.damaged_pieces)} must be a whole number of stones.`;
    else out.damaged_pieces = figure(out.damaged_pieces, PC_UNIT);
    const attribute = attributeProblem(out, at) || tidy(out, OUTPUT_TEXT, at);
    if (attribute) return attribute;

    for (const k of ['value_per_ct', 'value']) {
      if (blank(out[k])) delete out[k];
      else if (!positive(out[k])) return `${at}.${k} ${show(out[k])} must be more than 0.`;
      else out[k] = k === 'value' ? round2(figure(out[k])) : figure(out[k]);
    }
    if (out.value_per_ct && out.value) return `${at} has both value_per_ct and value. Keep the one the trader said.`;
    // A "by value" account shares cost by what the trader says each grade is worth: always asked.
    if (byValue && !out.value_per_ct && !out.value) {
      return `This account shares cost by value, so every output needs what the trader thinks it is worth: value_per_ct (or value for the whole output). `
        + `Missing on output ${i + 1} (${out.carats} ct). Ask the trader what each grade is worth per carat. ${NEVER_GUESS}`;
    }
  }
  return null;
}

/**
 * What a fee quoted at fee_basis comes to: { fee, units }, or { error } when the weights or the
 * counts it needs are not on every output. Reads outputs as the trader may have typed them, so
 * update_stock_op can use it before prepare has tidied them.
 */
function quotedFee(op) {
  const rate = figure(op.fee_rate);
  const outs = Array.isArray(op.outputs) ? op.outputs : [];
  let units = 1;
  if (op.fee_basis === 'per_ct') {
    const cts = outs.map((o) => figure(o && o.carats, CT_UNIT));
    if (!cts.length || cts.some((c) => !(c > 0))) return { error: 'A fee per carat needs the weight of every output. Ask the trader for it.' };
    units = lots.round3(cts.reduce((n, c) => n + c, 0));
  } else if (op.fee_basis === 'per_piece') {
    const pcs = outs.map((o) => figure(o && o.pieces, PC_UNIT));
    if (!pcs.length || pcs.some((c) => !(c > 0))) return { error: 'A fee per piece needs pieces on every output (how many stones came back). Ask the trader, or set the draft amount to the whole fee.' };
    units = pcs.reduce((n, c) => n + c, 0);
  }
  return { units, fee: round2(rate * units) };
}

/** The amount the server worked out from fee_rate (stock_op.fee_derived) goes when nothing is left to work it out from. */
function dropDerivedFee(draft, op) {
  if (!op.fee_derived) return;
  delete draft.amount;
  delete op.fee_derived;
}

/**
 * The fee of a transform is the draft's own money part. When it was quoted at a rate ("80 a
 * carat"), the amount is worked out here from the finished stones, never by the model, and marked
 * stock_op.fee_derived so it follows the rate and the weights (and can be told from a sum the trader
 * stated). What was transferred after withholding (paid_after_wht) is the trader's own figure:
 * the amount then comes from it (applyDefaults), and must agree with the quoted fee already here.
 */
function prepareFee(draft, op) {
  if (blank(op.fee_basis)) delete op.fee_basis;
  else {
    const basis = optionOf(op.fee_basis, lots.FEE_BASES);
    if (!basis) return `stock_op.fee_basis "${show(op.fee_basis)}" is not one of ${lots.FEE_BASES.join(', ')}.`;
    op.fee_basis = basis;
  }
  const paid = Number(draft.paid_after_wht) > 0;
  if (blank(op.fee_rate)) {
    delete op.fee_rate;
    dropDerivedFee(draft, op); // the rate is gone: so is the amount that came from it
  } else {
    const rate = figure(op.fee_rate);
    if (!(rate > 0)) return `stock_op.fee_rate ${show(op.fee_rate)} must be more than 0. No fee → leave fee_rate and amount out.`;
    op.fee_rate = rate;
    if (!['per_ct', 'per_piece', 'fixed'].includes(op.fee_basis)) {
      return 'stock_op.fee_rate needs fee_basis per_ct (per finished carat), per_piece or fixed. For a mixed fee set the draft amount to the whole fee instead.';
    }
    const { fee, units, error } = quotedFee(op);
    if (error) return error;
    if (paid) {
      delete op.fee_derived;
      const gross = Number(draft.wht_rate) > 0 && !(Array.isArray(draft.items) && draft.items.length) ? amountFromPaidAfterWht(draft, Number(draft.paid_after_wht)) : null;
      if (gross && gross.exact && Math.abs(gross.amount - fee) > 0.005) {
        return `Paid ${draft.paid_after_wht} after ${draft.wht_rate}% withholding tax means a fee of ${gross.amount}, but the fee as quoted is ${op.fee_rate} × ${units} = ${fee}. Ask the trader which is right, then correct fee_rate or paid_after_wht.`;
      }
    } else if (!(Number(draft.amount) > 0) || op.fee_derived) {
      draft.amount = fee;
      op.fee_derived = true;
    } else if (Math.abs(Number(draft.amount) - fee) > 0.005) {
      return `amount ${draft.amount} does not match the fee as quoted (${op.fee_rate} × ${units} = ${fee}). Ask the trader which is right, then set amount=${fee} or correct fee_rate.`;
    }
  }
  if (lots.hasMoney(draft)) {
    const tt = draft.transaction_type || 'cash';
    if (!['cash', 'bill_received'].includes(tt) || (draft.direction && draft.direction !== 'expense')) {
      return 'The fee for the work is money the trader pays: transaction_type=cash (paid now, with the wallet it came from) or bill_received (owed to the cutter), direction=expense.';
    }
    if (Array.isArray(draft.items) && draft.items.some((it) => it && it.item_code)) {
      return 'The fee of a stock operation cannot carry stock items (item_code). Remove items; the fee is the draft amount.';
    }
  }
  return null;
}

/** draft.stock_op: an operation that moves stones, not money (a transform may carry its fee). */
async function prepareStockOp(user, draft) {
  const op = draft.stock_op;
  const kind = blank(op.kind) ? null : optionOf(op.kind, lots.STOCK_OP_KINDS);
  if (!kind) return `stock_op.kind must be one of: ${KIND_WORDS}. Ask the trader what was done with the stones if it is not clear.`;
  op.kind = kind;
  if (kind === 'undo') return prepareUndo(draft, op);

  const words = tidy(op, ['job', 'direction', 'fee_basis', 'reference', 'lot', ...OP_TEXT], 'stock_op');
  if (words) return words;
  for (const k of ['fee_rate', 'memo_price_per_ct']) if (k in op && blank(op[k])) delete op[k];
  if (kind === 'transform') {
    const job = op.job && optionOf(op.job, lots.JOBS);
    if (!job) return `A transform needs stock_op.job: ${lots.JOBS.join(', ')}. Ask the trader what was done to the stones.`;
    op.job = job;
  } else {
    const fee = ['job', 'fee_basis', 'fee_rate'].filter((k) => k in op);
    if (fee.length) return `${fee.join(', ')} belong${fee.length === 1 ? 's' : ''} to a transform (cutting, heating, …). Stones that were worked on → kind=transform; otherwise remove ${fee.join(', ')} (set to null).`;
    if (lots.hasMoney(draft)) {
      return `Only a transform (cutting, heating, …) carries a fee; a ${kind} moves no money. Set amount to 0 here and record the cost as its own expense after this is saved.`;
    }
  }
  if (kind === 'move') {
    const direction = op.direction && optionOf(op.direction, lots.MOVE_DIRECTIONS);
    if (!direction) return 'A move needs stock_op.direction: out_work (sent to a cutter / heater), out_memo (sent on memo / consignment) or return (came back). Ask the trader which.';
    op.direction = direction;
  } else if ('direction' in op) {
    return `stock_op.direction is only for a move (out_work, out_memo, return). Remove it (set to null), or set kind=move.`;
  }
  if (op.reference || op.lot) return 'stock_op.reference and stock_op.lot are only for an undo. Remove them (set to null); the lots of this operation go in inputs.';

  // Said but never used would be dropped in silence: who holds the stones, when they are due back and the memo price are a move's (a transform keeps its holder).
  const stray = [];
  if (op.holder && kind !== 'move' && kind !== 'transform') stray.push('holder');
  if (op.due_date && !(kind === 'move' && op.direction !== 'return')) stray.push('due_date');
  if ('memo_price_per_ct' in op && !(kind === 'move' && op.direction === 'out_memo')) stray.push('memo_price_per_ct');
  if (stray.length) {
    return `${stray.join(', ')} ${stray.length === 1 ? 'does' : 'do'} not apply to this ${kind}${kind === 'move' ? ` (${op.direction})` : ''}: they are for stones sent out (a move). Remove ${stray.join(', ')} (set to null), or tell the trader it is not recorded.`;
  }

  const inputs = prepareInputs(op);
  if (inputs) return inputs;

  const makesLots = ['split', 'merge', 'transform'].includes(kind);
  if (!makesLots) {
    if (Array.isArray(op.outputs) && op.outputs.length) {
      return `A ${kind} has no outputs: the lot (and the carats, when only part of it ${kind === 'move' ? 'moves' : 'is written off'}) goes in inputs. Remove outputs.`;
    }
    if ('outputs' in op) delete op.outputs;
  } else {
    if (kind === 'split' && op.inputs.length !== 1) return 'A split works on one lot at a time. Put one lot in inputs; sort each lot with its own confirmation.';
    if (kind === 'merge' && op.inputs.length < 2) return 'A merge needs at least two lots in inputs. Ask the trader which lots go together.';
    if (kind === 'merge') {
      const filled = await fillMergeOutput(user, op);
      if (filled) return filled;
      if (op.outputs.length !== 1) return 'A merge makes one lot: give one output.';
    }
    if (!Array.isArray(op.outputs) || !op.outputs.length) {
      return `A ${kind} needs stock_op.outputs: what came out, each with its carats (and pieces when counted). Ask the trader for the weights. ${NEVER_GUESS}`;
    }
    const outputs = prepareOutputs(user, op);
    if (outputs) return outputs;
  }

  if (kind === 'move' && op.direction !== 'return' && !op.holder) {
    return `stock_op.holder is missing: who takes the stones (the ${op.direction === 'out_memo' ? 'broker or customer' : 'cutter or heater'})? Ask the trader.`;
  }
  if (kind === 'write_off' && !op.reason) return 'A write-off needs stock_op.reason (lost, broken, stolen, …). Ask the trader what happened.';
  if (op.due_date && !ISO_DATE.test(op.due_date)) return `stock_op.due_date "${op.due_date}" must be YYYY-MM-DD.`;
  if ('memo_price_per_ct' in op) {
    if (!positive(op.memo_price_per_ct)) return `stock_op.memo_price_per_ct ${show(op.memo_price_per_ct)} must be more than 0.`;
    op.memo_price_per_ct = figure(op.memo_price_per_ct);
  }

  if (kind === 'transform') {
    const fee = prepareFee(draft, op);
    if (fee) return fee;
  }

  // One date for the stones and for the fee: the operation is one event. A fee paid net of
  // withholding tax has no amount yet (applyDefaults derives it), but it is money all the same.
  const money = lots.hasMoney(draft);
  if (!op.date) op.date = (money && !blank(draft.transaction_date) && String(draft.transaction_date)) || today(user);
  if (!ISO_DATE.test(op.date)) return `stock_op.date "${op.date}" must be YYYY-MM-DD.`;
  if (money) {
    if (blank(draft.transaction_date)) draft.transaction_date = op.date;
    else if (String(draft.transaction_date) !== op.date) {
      return `The fee is dated ${draft.transaction_date} but the stones ${op.date}. Ask the trader which date is right and set transaction_date and stock_op.date to it.`;
    }
  }
  return null;
}

/**
 * Lot lines (draft.items[].lot): code normalised (lots.normCode), carats to 3 dp, pieces whole,
 * the line stored as { description, qty: 1, rate: <line total>, lot } with the total worked out
 * from lot.price × lot.pricing_basis (per_ct, per_g = 5 ct, per_kg, per_piece, total; a sale is
 * per_ct, per_piece or total); a sale line must name an existing lot code and may leave carats
 * out (the whole lot: its weight is read from the lot); a purchase line must say form and carats.
 * draft.stock_op: kind / job / direction from the lists in lots/index.js, date defaulted to
 * today (the user's own day), inputs and outputs shaped per kind (see StockOp there), codes
 * normalised, a fee quoted at fee_rate turned into the draft's amount (stock_op.fee_derived).
 * @returns {Promise<string|null>} one sentence saying what is missing or wrong (for the model to
 *   ask the trader); null when the draft is ready to resolve. Mutates the draft.
 */
async function prepare(user, draft) {
  if (!draft || typeof draft !== 'object') return 'There is no draft to prepare.';
  if (draft.stock_op != null) {
    if (!isObject(draft.stock_op)) return 'stock_op must be an object; set it with update_stock_op.';
    const problem = await prepareStockOp(user, draft);
    if (problem) return problem;
  }
  if (Array.isArray(draft.items) && draft.items.some((it) => it && it.lot != null)) {
    const problem = await prepareLotLines(user, draft);
    if (problem) return problem;
  }
  return null;
}

module.exports = { prepare, figure, plain, quotedFee, CT_UNIT, PC_UNIT };
