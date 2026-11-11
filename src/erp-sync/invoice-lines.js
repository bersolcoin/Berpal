/**
 * Invoice rows for Sales / Purchase Invoices.
 *
 *   draft.items present → one row per item. A row with item_code is a tracked stock Item
 *                         (items.resolveItem) and moves stock (update_stock=1, warehouse set);
 *                         a row without one uses the generic GEN-SALE / GEN-PURCHASE Item.
 *   no draft.items      → the original single generic row for draft.amount.
 *
 * Each row posts the LINE amount from taxes.computeTotals: the net (VAT is a separate Actual tax
 * row), or the gross when the VAT is not claimable (no VAT row; the VAT is part of the cost, so a
 * stone is valued at gross as TAS 2 requires). ERPNext stores 2-dp unit rates, so a line amount
 * that doesn't divide by its qty is posted as:
 *   untracked line → qty 1 at the line amount, "<qty> × <description>" (prints cleanly)
 *   stock line     → the real qty (the Bin must move by it) at the rate rounded down, plus a
 *                    "Rounding" GEN row for the leftover satang (< qty × 0.01)
 *
 * Gem lots (src/lots): a line listed in `lots` is one lot. The draft states it as qty 1 at the
 * line total; its row moves the lot's carats of the lot's batch in the lot's warehouse, at the
 * best 2-dp rate per carat, with the same "Rounding" row for what the rate cannot carry.
 */
const { companyCurrency, resolveErpAccount, ensureGenericItem, round2 } = require('./common');
const { vatTreatment } = require('./taxes');
const items = require('./items');

const LOT_UOM = 'Carat';

/** [{ qty, rate, rounding }] for a line amount; rounding is the satang a stock line can't carry. */
function splitLine(amount, qty, stock) {
  const cents = Math.round(amount * 100);
  if (cents % qty === 0) return { qty, rate: cents / qty / 100, rounding: 0, collapsed: false };
  if (!stock) return { qty: 1, rate: round2(amount), rounding: 0, collapsed: true };
  const unit = Math.floor(cents / qty);
  return { qty, rate: unit / 100, rounding: (cents - unit * qty) / 100, collapsed: false };
}

/**
 * { rate, rounding } for a lot line: the highest 2-dp rate per carat whose amount (ERPNext rounds
 * carats × rate to 2 dp) does not exceed the line amount; rounding is what is left over.
 */
function splitLotLine(amount, carats) {
  const fits = (rate) => round2(carats * rate) <= round2(amount);
  const exact = round2(amount / carats);
  if (round2(carats * exact) === round2(amount)) return { rate: exact, rounding: 0 };
  let cents = Math.floor(amount / carats * 100);
  while (cents > 0 && !fits(cents / 100)) cents -= 1;
  return { rate: cents / 100, rounding: round2(amount - round2(carats * cents / 100)) };
}

/**
 * side: 'sales' | 'purchase'. totals: taxes.computeTotals(draft, fallbackDescription).
 * lots: [{ line, item, batch, warehouse, carats }] for the lines that are gem lots (else none).
 * Returns { rows, updateStock, warehouse }.
 */
async function buildInvoiceLines(user, erp, draft, side, { lineAccount, totals, lots = null }) {
  const sales = side === 'sales';
  const gross = !sales && vatTreatment(user, draft) === 'non_claimable';
  const lotOf = new Map((lots || []).map((l) => [l.line, l]));
  const anyStock = totals.lines.some((l, i) => l.item_code && !lotOf.has(i));
  const warehouse = anyStock ? await items.resolveWarehouse(erp) : null;
  // Selling a stock item books COGS at valuation. Set it explicitly so it lands on the same
  // COGS account the chart maps 5000 to, not whatever the company default happens to be.
  const cogsAccount = sales && (anyStock || lotOf.size) ? await resolveErpAccount(user, erp, '5000', companyCurrency(user)) : null;
  const accountField = sales ? 'income_account' : 'expense_account';
  const genericCode = () => ensureGenericItem(erp, sales ? 'sale' : 'purchase');
  const accountFields = lineAccount ? { [accountField]: lineAccount } : {};

  const rows = [];
  for (const [i, l] of totals.lines.entries()) {
    const amount = gross ? l.gross : l.net;
    const lot = lotOf.get(i);
    if (lot) {
      const split = splitLotLine(amount, lot.carats);
      rows.push({
        item_code: lot.item,
        qty: lot.carats,
        rate: split.rate,
        description: l.description,
        uom: LOT_UOM,
        stock_uom: LOT_UOM,
        conversion_factor: 1,
        warehouse: lot.warehouse,
        batch_no: lot.batch,
        use_serial_batch_fields: 1,
        ...accountFields,
        ...(cogsAccount ? { expense_account: cogsAccount } : {}),
      });
      if (split.rounding) {
        rows.push({
          item_code: await genericCode(),
          qty: 1,
          rate: split.rounding,
          description: `Rounding: ${l.description}`,
          ...accountFields,
        });
      }
      continue;
    }
    const stock = !!l.item_code;
    const split = splitLine(amount, l.qty, stock);
    let itemCode;
    let stockFields = {};
    if (stock) {
      const item = await items.resolveItem(user, erp, { item_code: l.item_code, description: l.description });
      itemCode = item.erpnext_name;
      stockFields = { warehouse, ...(cogsAccount ? { expense_account: cogsAccount } : {}) };
    } else {
      itemCode = await genericCode();
    }
    rows.push({
      item_code: itemCode,
      qty: split.qty,
      rate: split.rate,
      description: split.collapsed ? `${l.qty} × ${l.description}` : l.description,
      ...accountFields,
      ...stockFields,
    });
    if (split.rounding) {
      rows.push({
        item_code: await genericCode(),
        qty: 1,
        rate: split.rounding,
        description: `Rounding: ${l.qty} × ${l.description}`,
        ...accountFields,
      });
    }
  }
  return { rows, updateStock: anyStock || lotOf.size ? 1 : 0, warehouse };
}

module.exports = { buildInvoiceLines, splitLine, splitLotLine };
