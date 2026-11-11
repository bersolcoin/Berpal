/**
 * Gem lots: shared constants, small helpers and the contracts between the lot modules.
 * Design: docs/parcel-lot-stock-design.md. Who builds what: docs/parcel-lot-stock-build.md.
 *
 *   draft.js     normalise + validate the draft's lot lines and stock_op          (chat lane)
 *   card.js      the confirmation card for a ResolvedOp                            (chat lane)
 *   resolve.js   draft → ResolvedOp, from Berpal's own lot rows                    (ledger lane)
 *   cost.js      cost sharing, tolerances, yield                                   (ledger lane)
 *   store.js     the ONLY writer of lots / lot_ops / lot_op_lines / lot_custody    (ledger lane)
 *   erp.js       items, batches, warehouses, accounts, stock read-back             (ERPNext lane)
 *   stock-entry.js  Repack / Material Transfer / Material Issue payloads           (ERPNext lane)
 *   execute.js   run a ResolvedOp against ERPNext, step by step, resumable         (ERPNext lane)
 *   recover.js   put the record straight after a crash (never posts)               (ERPNext lane)
 *   undo.js      cancel an operation's documents, put the lot rows back            (custody lane)
 *   custody.js, reconcile.js, digest.js   who holds what, nightly check, digest    (custody lane)
 *   gate.js      the spine: request_confirmation / save_transaction / retry for lot drafts
 *
 * How an operation is recorded (store.js): beginOp ('pending', before ERPNext hears of it) →
 * recordStep per posted document ('partial') → postOp with the actuals read back from ERPNext
 * ('posted'; lots, lines and custody change in one transaction) — or failOp when nothing was
 * posted. Undo: markUndoing → markDocCancelled per document → reverseOp ('undone').
 *   actuals = { inputs: { [code]: { cost } }, outputs: { [code]: { cost, item, batch } } }
 * One unfinished operation per user blocks every other lot operation until it is retried or undone.
 *
 * Everything here is switched on per user (users.niche = 'gems'); nothing changes for anyone else.
 */
const crypto = require('crypto');
const { localClock } = require('../jobs');

const NICHE = 'gems';
const COST_METHODS = ['value', 'weight'];
const DEFAULT_COST_METHOD = 'value';

/** lot_ops.kind. 'buy' and 'sell' come from lot lines on a bill / invoice; the rest from draft.stock_op. */
const OP_KINDS = ['buy', 'sell', 'split', 'merge', 'transform', 'move', 'write_off'];
/** draft.stock_op.kind. 'undo' never becomes a lot_ops row of its own: it flips one to 'undone'. */
const STOCK_OP_KINDS = ['split', 'merge', 'transform', 'move', 'write_off', 'undo'];
const JOBS = ['cutting', 'sawing', 'heating', 'preform', 'recut', 'reweigh'];
const MOVE_DIRECTIONS = ['out_work', 'out_memo', 'return'];
/** Place key → ERPNext warehouse name (before " - <abbr>"). */
const PLACES = { stores: 'Stores', work: 'Out for work', memo: 'Out on memo' };
const FORMS = ['rough', 'preform', 'cut', 'cabochon', 'bead'];
const TREATMENTS = ['none', 'H', 'H-FH', 'H-D', 'H-GF', 'FF-O', 'LGH', 'unknown'];
/** What a merge of lots with different treatments is marked as. Never stated by the trader, so not in TREATMENTS. */
const MIXED_TREATMENT = 'mixed';
const PRICING_BASES = ['per_ct', 'per_g', 'per_kg', 'per_piece', 'total'];
const FEE_BASES = ['per_ct', 'per_piece', 'fixed', 'mixed'];
const CARATS_PER_GRAM = 5;

/**
 * Our category code for a cutter's / heater's fee that goes into the cost of the stones. It maps
 * (erp-sync/common.js ERP_CODE_MAP) to ERPNext's "Expenses Included In Valuation" holding account;
 * the transform's stock entry then moves it from there into stock. Set by the gate, never by the model.
 */
const FEE_CATEGORY_CODE = '5010';
const HOLDING_ACCOUNT_NUMBER = '5118';      // Expenses Included In Valuation
const ADJUSTMENT_ACCOUNT_NUMBER = '5119';   // Stock Adjustment: value differences on repacks

const isGems = (user) => !!user && user.niche === NICHE;
/**
 * The day an entry with no date falls on. A gem account's own day (its timezone): a lot bought at
 * 06:00 in Bangkok and sorted an hour later must not be dated a day apart. Everyone else keeps
 * the UTC date, as before.
 */
const today = (user) => (isGems(user) ? localClock(new Date(), user.timezone).date : new Date().toISOString().slice(0, 10));
const costMethod = (user) => (user && COST_METHODS.includes(user.lot_cost_method) ? user.lot_cost_method : DEFAULT_COST_METHOD);

/** Carats: 3 decimals, float noise shed first (0.1 + 0.2 → 0.3). */
function round3(n) {
  return Math.round(Number((Number(n) * 1000).toFixed(6))) / 1000;
}

/** "l 12" / "L-12 " → "L12" / "L-12". null when it cannot be a lot code. */
function normCode(code) {
  if (code == null) return null;
  const c = String(code).trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9][A-Z0-9\-/.]{0,19}$/.test(c) ? c : null;
}

/** Which of the two ERPNext items a form sits under. Tax treatment reads the form, never this. */
function itemKind(form) {
  return form === 'cut' || form === 'cabochon' || form === 'bead' ? 'cut' : 'rough';
}

const lotLines = (draft) => (Array.isArray(draft && draft.items) ? draft.items.filter((l) => l && l.lot && typeof l.lot === 'object') : []);
const hasLotLines = (draft) => lotLines(draft).length > 0;
const hasStockOp = (draft) => !!(draft && draft.stock_op && typeof draft.stock_op === 'object');
/** A draft the lot gate handles instead of the plain money path. */
const applies = (draft) => hasStockOp(draft) || hasLotLines(draft);
/**
 * Does the draft carry a money document as well? Lot lines always do (the bill / invoice). A
 * stock_op does only when a fee is set on the draft's normal money fields (a transform's fee):
 * the amount, or what was paid after withholding tax (the amount is then worked out from it).
 */
const hasMoney = (draft) => hasLotLines(draft)
  || (hasStockOp(draft) && (Number(draft.amount) > 0 || Number(draft.paid_after_wht) > 0));

/** JSON with object keys sorted at every depth: the same value always gives the same string. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * What a ResolvedOp will do, as a comparable string: the card signs it, save re-checks it. It
 * covers the state of the input lots as read at card time (before.*), so a lot that changed
 * between the card and the save (another operation, a sale) refuses the save.
 */
function opSignature(op) {
  if (!op) return '';
  const { warnings, ...rest } = op; // advisory lines; the money-draft signature covers trust warnings
  return crypto.createHash('sha256').update(canonical(rest)).digest('hex').slice(0, 32);
}

/** Short, unique, greppable: goes into ERPNext `remarks` as "Berpal lot op <reference> step n/m". */
function newReference() {
  return `BPL-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
const remarkFor = (reference, step, of) => `Berpal lot op ${reference} step ${step}/${of}`;

/**
 * @typedef {object} LotLine  draft.items[i].lot — a lot bought or sold on a bill / invoice line.
 *   The line itself is stored as { description, qty: 1, rate: <line total>, lot } (draft.js
 *   normalises price × basis into the line total), so the tax and item code stays untouched.
 * @property {string} [code]        buy: the trader's own code (else one is assigned). sell: required.
 * @property {number} carats        carats bought / sold
 * @property {number} [pieces]
 * @property {boolean} [weight_estimated]
 * @property {number} [price]       as the trader said it, with pricing_basis
 * @property {'per_ct'|'per_g'|'per_kg'|'per_piece'|'total'} [pricing_basis]
 * @property {string} [form]        buy only, like the remaining attributes:
 *   species, variety, shape, size, colour, clarity, origin, grade, description, treatment,
 *   treatment_source, supplier_doc, vat_exempt
 */

/**
 * @typedef {object} StockOp  draft.stock_op — an operation that moves stones, not money.
 * @property {'split'|'merge'|'transform'|'move'|'write_off'|'undo'} kind
 * @property {'cutting'|'sawing'|'heating'|'preform'|'recut'|'reweigh'} [job]   transform
 * @property {'out_work'|'out_memo'|'return'} [direction]                        move
 * @property {string} [date]        YYYY-MM-DD, defaults to today
 * @property {Array<{lot: string, carats?: number, pieces?: number}>} [inputs]   carats omitted = the whole lot
 * @property {Array<object>} [outputs]  { code?, carats, pieces?, damaged_pieces?, value_per_ct?, value?,
 *   form?, treatment?, grade?, shape?, size?, colour?, clarity?, description? }
 * @property {string} [holder]      who takes / returns the stones
 * @property {string} [due_date]
 * @property {number} [memo_price_per_ct]
 * @property {'per_ct'|'per_piece'|'fixed'|'mixed'} [fee_basis]  how the fee was quoted (the amount is the draft's)
 * @property {number} [fee_rate]    the rate quoted per carat, per piece or as a fixed sum; draft.prepare turns it into the draft's amount
 * @property {boolean} [fee_derived] true while the draft's amount was worked out from fee_rate (not stated by the trader), so it is re-derived or removed with it
 * @property {string} [reason]      write_off
 * @property {string} [note]
 * @property {string} [reference]   undo: the operation to undo…
 * @property {string} [lot]         …or the lot whose newest operation to undo
 * A transform's fee is NOT in here: it is the draft's normal money part (amount, counterparty,
 * cash or bill_received, VAT / WHT), with category_code forced to FEE_CATEGORY_CODE by the gate.
 */

/**
 * @typedef {object} ResolvedInput
 * @property {string} code
 * @property {number} lot_id
 * @property {number} carats     taken by this operation
 * @property {number|null} pieces
 * @property {number} cost       cost taken, company currency (whole lot: all of it; part: at the lot's average)
 * @property {boolean} whole     the lot is emptied
 * @property {'stores'|'work'|'memo'} from
 * @property {string} item       ERPNext item code of the lot
 * @property {string} batch      ERPNext batch of the lot
 * @property {{carats:number, pieces:number|null, cost:number, form:string|null, treatment:string|null,
 *   holder:string|null, description:string|null, last_op_date:string|null}} before  the lot as read
 */

/**
 * @typedef {object} ResolvedOutput
 * @property {string} code
 * @property {boolean} new       a lot row is created (false: an existing lot is topped up or re-batched)
 * @property {number|null} lot_id  when !new
 * @property {number} carats
 * @property {number|null} pieces
 * @property {number} damaged_pieces
 * @property {number} cost       planned cost, company currency; outputs sum exactly to inputs + fee
 * @property {'stores'|'work'|'memo'} to
 * @property {'rough'|'cut'} item_kind
 * @property {number} revision   batch revision the output takes (0 for a new lot)
 * @property {boolean} weight_estimated
 * @property {number|null} line  buy / sell: index into draft.items; stock ops: index into stock_op.outputs
 * @property {object} attrs      lots columns to write: form, species, variety, shape, size, colour, clarity,
 *   origin, grade, description, treatment, treatment_source, purchase_unit, pricing_basis, supplier,
 *   supplier_doc, vat_exempt
 */

/**
 * @typedef {object} ResolvedOp  What one confirmation will do to the lots. Pure data (JSON-safe):
 *   it is stored in lot_ops.plan and must be enough to finish the operation after a restart.
 * @property {'buy'|'sell'|'split'|'merge'|'transform'|'move'|'write_off'} kind
 * @property {string|null} job
 * @property {string|null} direction
 * @property {string} date           YYYY-MM-DD
 * @property {'value'|'weight'} method   the user's cost-sharing method at resolve time
 * @property {ResolvedInput[]} inputs    [] for a buy
 * @property {ResolvedOutput[]} outputs  [] for a sell or a write-off
 * @property {{amount:number, capitalised:number, basis:string|null}|null} fee  capitalised = what goes into stock
 * @property {number|null} yield_pct   transform: carats out ÷ carats in × 100, 1 dp
 * @property {number} loss_carats      carats in − carats out (0 when none)
 * @property {string|null} holder
 * @property {string|null} due_date
 * @property {number|null} memo_price_per_ct
 * @property {string|null} reason
 * @property {string|null} note
 * @property {string|null} counterparty  buy / sell: the supplier / customer name
 * @property {string[]} warnings      advisory card lines (yield out of range, estimated weight, …)
 */

/**
 * @typedef {object} RunResult  execute.run / undo.run
 * @property {boolean} ok
 * @property {string} reference
 * @property {Array<{step:number, doctype:string, name:string}>} docs   every ERPNext document posted so far
 * @property {{doctype:string, erpnext_name:string}|null} [saved]       ok: the document to show as "Ref"
 * @property {{doctype:string, erpnext_name:string}|null} [money_doc]   ok: the bill / invoice / fee payment, if any
 * @property {Array<{code:string, carats:number, pieces:number|null, cost:number, location:string}>} [lots]  ok: lots after
 * @property {boolean} [partial]   !ok: something was posted before the failure, or nobody knows whether it was (the draft is kept for a retry)
 * @property {string} [error]
 * undo.run only (each entry { step, doctype, name, party?, amount?, currency? }, newest step first):
 * @property {object[]} [cancelled]  documents of the operation that are cancelled, now or earlier
 * @property {object[]} [standing]   documents of the operation still in force
 * @property {string[]} [removed]    ok: codes of the lots the operation had made, gone again
 * @property {{certificates: object[], detailsChanged: string[]}} [lost]  ok: what went with it (store.reverseLosses)
 */

module.exports = {
  NICHE, COST_METHODS, DEFAULT_COST_METHOD, OP_KINDS, STOCK_OP_KINDS, JOBS, MOVE_DIRECTIONS, PLACES, FORMS,
  TREATMENTS, MIXED_TREATMENT, PRICING_BASES, FEE_BASES, CARATS_PER_GRAM, FEE_CATEGORY_CODE, HOLDING_ACCOUNT_NUMBER,
  ADJUSTMENT_ACCOUNT_NUMBER,
  isGems, today, costMethod, round3, normCode, itemKind, lotLines, hasLotLines, hasStockOp, applies, hasMoney,
  canonical, opSignature, newReference, remarkFor,
};
