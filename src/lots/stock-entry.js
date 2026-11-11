/**
 * ERPNext Stock Entry payloads for lot operations. Pure builders: names in, a document out.
 *
 * Every row carries uom / stock_uom 'Carat', conversion_factor 1, use_serial_batch_fields 1,
 * batch_no, expense_account and cost_center. Output rows whose value Berpal sets carry
 * set_basic_rate_manually 1, basic_rate and basic_amount. `remarks` is lots.remarkFor(...).
 */
const lots = require('./index');
const { round2 } = require('../erp-sync/common');

const UOM = 'Carat';
const FEE_DESCRIPTION = 'Cutting / treatment fee';

/**
 * @typedef {object} EntryContext
 * @property {string} company
 * @property {string} date          posting date YYYY-MM-DD
 * @property {string} remark        lots.remarkFor(reference, step, of)
 * @property {{holding: string, adjustment: string, stockLoss: string, costCenter: string}} accounts
 * @typedef {object} EntryRow   { item, batch, warehouse, carats, cost?, to? }  cost: what Berpal says it is
 *   worth (repack targets); to: the warehouse a transfer row goes to (warehouse is where it leaves)
 */

function entry(ctx, type, items, extra = {}) {
  return {
    stock_entry_type: type,
    purpose: type,
    company: ctx.company,
    posting_date: ctx.date,
    set_posting_time: 1,
    remarks: ctx.remark,
    items,
    ...extra,
    docstatus: 1,
  };
}

/** The fields every row carries. Any value difference on the entry posts to `account`. */
function baseRow(ctx, r, account) {
  return {
    item_code: r.item,
    qty: lots.round3(r.carats),
    uom: UOM,
    stock_uom: UOM,
    conversion_factor: 1,
    batch_no: r.batch,
    use_serial_batch_fields: 1,
    expense_account: account,
    cost_center: ctx.accounts.costCenter,
  };
}

/**
 * A row that comes in at the value Berpal gives it. ERPNext values the stock ledger from the rate,
 * so the rate goes unrounded (30 ct for 272,400 is not a round figure per carat): the amount is
 * what has to be right. A row worth nothing has to say so, or ERPNext looks a rate up itself.
 */
function valuedRow(ctx, r, basic) {
  const qty = lots.round3(r.carats);
  return {
    ...baseRow(ctx, r, ctx.accounts.adjustment),
    t_warehouse: r.warehouse,
    set_basic_rate_manually: 1,
    basic_rate: basic / qty,
    basic_amount: basic,
    ...(basic > 0 ? {} : { allow_zero_valuation_rate: 1 }),
  };
}

/**
 * What each output is worth before the fee, so that with its share of the fee it comes to its
 * cost. ERPNext spreads additional costs over the output rows in proportion to these amounts,
 * in whole satang; a satang either way on a row is tried so that the shares land exactly.
 */
function basicAmounts(costs, fee) {
  const total = round2(costs.reduce((s, c) => s + c, 0));
  const basicTotal = round2(total - fee);
  if (!(fee > 0)) return costs.map(round2);
  if (!(basicTotal > 0)) throw new Error('A fee cannot be added to stones that carry no cost of their own');
  let left = basicTotal;
  return costs.map((cost, i) => {
    if (i === costs.length - 1) return round2(left);
    const guess = round2(cost * basicTotal / total);
    const lands = (b) => round2(b + round2(fee * b / basicTotal)) === round2(cost);
    const basic = [0, 0.01, -0.01, 0.02, -0.02].map((d) => round2(guess + d)).find(lands) ?? guess;
    left = round2(left - basic);
    return basic;
  });
}

/** Stones change lot / form / place: sources out, targets in at the values given; a fee is added from the holding account. */
function repack(ctx, { sources, targets, fee = null }) {
  if (!sources || !sources.length || !targets || !targets.length) throw new Error('A repack needs stones going in and stones coming out');
  const amount = round2(Number(fee && typeof fee === 'object' ? fee.amount : fee) || 0);
  const basics = basicAmounts(targets.map((t) => Number(t.cost) || 0), amount);
  const items = [
    ...sources.map((s) => ({ ...baseRow(ctx, s, ctx.accounts.adjustment), s_warehouse: s.warehouse })),
    ...targets.map((t, i) => valuedRow(ctx, t, basics[i])),
  ];
  const costs = amount > 0
    ? { additional_costs: [{ expense_account: ctx.accounts.holding, description: (fee && fee.description) || FEE_DESCRIPTION, amount }] }
    : {};
  return entry(ctx, 'Repack', items, costs);
}

/** A whole lot changes warehouse and nothing else. */
function transfer(ctx, { rows }) {
  if (!rows || !rows.length) throw new Error('A transfer needs at least one lot');
  return entry(ctx, 'Material Transfer', rows.map((r) => ({
    ...baseRow(ctx, r, ctx.accounts.adjustment), s_warehouse: r.warehouse, t_warehouse: r.to,
  })));
}

/** Stones are gone (lost, broken, stolen): out of stock to the stock loss account. */
function issue(ctx, { rows }) {
  if (!rows || !rows.length) throw new Error('A write-off needs at least one lot');
  return entry(ctx, 'Material Issue', rows.map((r) => ({
    ...baseRow(ctx, r, ctx.accounts.stockLoss), s_warehouse: r.warehouse,
  })));
}

module.exports = { repack, transfer, issue };
