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
 */
const { companyCurrency, resolveErpAccount, ensureGenericItem, round2 } = require('./common');
const { vatTreatment } = require('./taxes');
const items = require('./items');

/** [{ qty, rate, rounding }] for a line amount; rounding is the satang a stock line can't carry. */
function splitLine(amount, qty, stock) {
  const cents = Math.round(amount * 100);
  if (cents % qty === 0) return { qty, rate: cents / qty / 100, rounding: 0, collapsed: false };
  if (!stock) return { qty: 1, rate: round2(amount), rounding: 0, collapsed: true };
  const unit = Math.floor(cents / qty);
  return { qty, rate: unit / 100, rounding: (cents - unit * qty) / 100, collapsed: false };
}

/**
 * side: 'sales' | 'purchase'. totals: taxes.computeTotals(draft, fallbackDescription).
 * Returns { rows, updateStock, warehouse }.
 */
async function buildInvoiceLines(user, erp, draft, side, { lineAccount, totals }) {
  const sales = side === 'sales';
  const gross = !sales && vatTreatment(user, draft) === 'non_claimable';
  const anyStock = totals.lines.some((l) => l.item_code);
  const warehouse = anyStock ? await items.resolveWarehouse(erp) : null;
  // Selling a stock item books COGS at valuation. Set it explicitly so it lands on the same
  // COGS account the chart maps 5000 to, not whatever the company default happens to be.
  const cogsAccount = sales && anyStock ? await resolveErpAccount(user, erp, '5000', companyCurrency(user)) : null;
  const accountField = sales ? 'income_account' : 'expense_account';
  const genericCode = () => ensureGenericItem(erp, sales ? 'sale' : 'purchase');
  const accountFields = lineAccount ? { [accountField]: lineAccount } : {};

  const rows = [];
  for (const l of totals.lines) {
    const amount = gross ? l.gross : l.net;
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
  return { rows, updateStock: anyStock ? 1 : 0, warehouse };
}

module.exports = { buildInvoiceLines, splitLine };
