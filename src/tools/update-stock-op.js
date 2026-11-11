const lots = require('../lots');
const { figure, quotedFee } = require('../lots/draft');
const { stripProtected } = require('./validate');
const { ts } = require('../erp-sync/common');

// The keys of draft.stock_op (StockOp in src/lots/index.js, plus fee_rate: src/lots/draft.js).
const FIELDS = ['kind', 'job', 'direction', 'date', 'inputs', 'outputs', 'holder', 'due_date', 'memo_price_per_ct',
  'fee_basis', 'fee_rate', 'reason', 'note', 'reference', 'lot'];

const definition = {
  name: 'update_stock_op',
  description:
    'Gem lots: draft an operation that moves STONES, not money: split (sort into grades), merge, transform (cutting, sawing, heating, preform, recut, reweigh), move (out for work or on memo, and back), write_off, or undo (take the newest operation back). Buying and selling lots is NOT this tool (update_draft, lot block). Then request_confirmation and wait for the yes. Fields merge into the current operation; a different kind starts afresh; null removes a field; inputs and outputs are replaced whole. A transform\'s fee is money: fee_rate here, or amount / cash or bill / counterparty via update_draft; never category_code. Never invent a lot code, weight, piece count or value: ask.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: lots.STOCK_OP_KINDS },
      job: { type: 'string', enum: lots.JOBS, description: 'transform only: what was done to the stones.' },
      direction: { type: 'string', enum: lots.MOVE_DIRECTIONS, description: 'move only: out_work = sent to a cutter / heater, out_memo = sent on memo (consignment), return = came back unchanged.' },
      date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      inputs: {
        type: 'array',
        description: 'The lot(s) it is done to. Leave carats out for the whole lot.',
        items: {
          type: 'object',
          properties: {
            lot: { type: 'string', description: 'Lot code.' },
            carats: { type: 'number', description: 'Only when part of the lot is taken.' },
            pieces: { type: 'number', description: 'Only when counted.' },
          },
          required: ['lot'],
        },
      },
      outputs: {
        type: 'array',
        description: 'split / merge / transform: what came out, one entry per lot.',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Only when the trader names the new lot.' },
            carats: { type: 'number' },
            pieces: { type: 'number', description: 'Only when counted.' },
            damaged_pieces: { type: 'number', description: 'Stones broken in the work.' },
            value_per_ct: { type: 'number', description: 'What the trader thinks it is worth per carat (shares the cost). Or value, never both.' },
            value: { type: 'number', description: 'The same for the whole output.' },
            form: { type: 'string', enum: lots.FORMS, description: 'When it changes.' },
            treatment: { type: 'string', enum: lots.TREATMENTS, description: 'When it changes, e.g. H after heating.' },
            grade: { type: 'string' },
            shape: { type: 'string' },
            size: { type: 'string' },
            colour: { type: 'string' },
            clarity: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      holder: { type: 'string', description: 'move: who takes the stones (cutter, heater, broker, customer).' },
      due_date: { type: 'string', description: 'move out: YYYY-MM-DD the stones are due back.' },
      memo_price_per_ct: { type: 'number', description: 'out_memo: the price per carat on the memo slip.' },
      fee_basis: { type: 'string', enum: lots.FEE_BASES, description: 'transform: how the fee was quoted.' },
      fee_rate: { type: 'number', description: 'transform: the fee as quoted, with fee_basis per_ct (per finished carat), per_piece or fixed. The amount is worked out for you.' },
      no_fee: { type: 'boolean', description: 'transform: true = there is no fee after all (removes the fee amount and its rate).' },
      reason: { type: 'string', description: 'write_off: what happened (lost, broken, stolen, …).' },
      note: { type: 'string' },
      reference: { type: 'string', description: 'undo only: the reference (BPL-…) of the operation to take back.' },
      lot: { type: 'string', description: 'undo only: the lot whose newest operation to take back.' },
      clear: { type: 'boolean', description: 'true = drop the stock operation from the draft.' },
    },
  },
};

/** A gate-set fee category has no business on a draft that is no longer a transform's fee. */
function dropFeeCategory(draft) {
  if (String(draft.category_code) === lots.FEE_CATEGORY_CODE) delete draft.category_code;
}

/**
 * A stock operation may only join a draft that is empty or already the fee of stone work (cash or a
 * bill, an expense, no category of its own). Anything else would be turned into that fee by the
 * gate: a lunch expense into a cost added to the stones.
 */
function unrelatedDraft(draft, kind) {
  const items = Array.isArray(draft.items) && draft.items.length > 0;
  const money = Number(draft.amount) > 0 || Number(draft.paid_after_wht) > 0;
  const category = draft.category_code != null && draft.category_code !== '' && String(draft.category_code) !== lots.FEE_CATEGORY_CODE;
  const type = draft.transaction_type && !['cash', 'bill_received'].includes(draft.transaction_type);
  const direction = draft.direction && draft.direction !== 'expense';
  if (!(items || type || direction || category || (money && kind !== 'transform'))) return null;
  const bits = [items ? 'items' : null, money ? `${draft.amount || draft.paid_after_wht} ${draft.currency || ''}`.trim() : null,
    category ? `category ${draft.category_code}` : null, draft.description ? `"${draft.description}"` : null].filter(Boolean);
  return `The draft already holds another entry (${bits.join(', ') || draft.transaction_type || draft.direction}). A stock operation cannot be added to it: `
    + 'save it first (request_confirmation, then the trader\'s yes) or discard it (cancel_transaction), then draft the stone operation. A cutter\'s fee needs no category: the system sets it.';
}

/**
 * The fee amount the server worked out (stock_op.fee_derived) follows the rate and the weights:
 * worked out when a rate is first said, again when the rate, the basis or an output changes, gone
 * when nothing is left to work it out from. A sum the trader stated is never touched here.
 */
function followFee(draft) {
  const op = draft.stock_op;
  if (op.kind !== 'transform') return;
  const quoted = typeof op.fee_basis === 'string' && ['per_ct', 'per_piece', 'fixed'].includes(op.fee_basis.toLowerCase()) && figure(op.fee_rate) > 0
    && !(Number(draft.paid_after_wht) > 0);
  if (quoted) {
    const fee = quotedFee({ ...op, fee_basis: op.fee_basis.toLowerCase() });
    if (!fee.error && (op.fee_derived || !(Number(draft.amount) > 0))) {
      draft.amount = fee.fee;
      op.fee_derived = true;
      return;
    }
    if (!fee.error) return;
  }
  if (op.fee_derived) {
    delete draft.amount;
    delete op.fee_derived;
  }
}

async function execute(args, ctx) {
  if (args.clear === true) {
    const draft = { ...ctx.draft };
    const was = lots.hasStockOp(draft) ? draft.stock_op : null;
    delete draft.stock_op;
    for (const k of ['confirmation_pending', 'confirmation_sig', 'trust_warnings', 'receipt_hash']) delete draft[k];
    if (was && was.fee_derived) delete draft.amount;
    dropFeeCategory(draft);
    // The money of a transform's draft was only ever its fee (cash or bill, who was paid, the wallet): it goes too.
    const feeOnly = was && was.kind === 'transform' && lots.hasMoney({ ...ctx.draft, items: undefined }) && !(Array.isArray(draft.items) && draft.items.length);
    ctx.draft = feeOnly ? {} : draft;
    console.log(`• [tools] [${ts()}] tool=update_stock_op cleared`);
    return { ok: true, current_draft: stripProtected(ctx.draft) };
  }

  const current = lots.hasStockOp(ctx.draft) ? ctx.draft.stock_op : null;
  let kind = current ? current.kind : null;
  if (args.kind != null) {
    kind = typeof args.kind === 'string' ? lots.STOCK_OP_KINDS.find((k) => k === args.kind.trim().toLowerCase()) || null : null;
    if (!kind) return { ok: false, error: `kind "${args.kind}" is not a stock operation. Use one of: ${lots.STOCK_OP_KINDS.join(', ')}. Buying or selling a lot is update_draft with a lot block on the item line.` };
  }
  if (!kind) return { ok: false, error: `Say what is being done first: kind = ${lots.STOCK_OP_KINDS.join(', ')}.` };
  if (!current) {
    const unrelated = unrelatedDraft(ctx.draft, kind);
    if (unrelated) return { ok: false, error: unrelated };
  }

  // A different kind is a different operation: nothing of the old one carries over, its fee amount included.
  const same = current && current.kind === kind;
  const op = same ? { ...current } : {};
  op.kind = kind;
  const ignored = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'kind' || k === 'clear' || k === 'no_fee') continue;
    if (!FIELDS.includes(k)) { ignored.push(k); continue; }
    if (v == null || v === '') delete op[k];
    else op[k] = Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v;
  }
  const draft = { ...ctx.draft, stock_op: op };
  if (current && current.fee_derived && !same) delete draft.amount;
  if (kind !== 'transform') dropFeeCategory(draft);
  if (args.no_fee === true && kind === 'transform') {
    for (const k of ['fee_basis', 'fee_rate', 'fee_derived']) delete op[k];
    delete draft.amount;
    delete draft.paid_after_wht;
  }
  followFee(draft);
  ctx.draft = draft;
  console.log(`• [tools] [${ts()}] tool=update_stock_op stock_op=${JSON.stringify(op)}`);
  return {
    ok: true,
    current_draft: stripProtected(ctx.draft),
    ...(ignored.length ? { note: `Not applied: ${ignored.join(', ')} ${ignored.length === 1 ? 'is' : 'are'} not part of a stock operation (money fields go through update_draft).` } : {}),
  };
}

module.exports = { definition, execute, niche: 'gems' };
