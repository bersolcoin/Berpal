/**
 * Detail view for a single Item — header info + stock per warehouse (if
 * stock item) + recent stock movements + recent invoice appearances.
 *
 * Used by both /inventory/[code] and /services/[code]. Returns null for
 * `bins` / `movements` on non-stock items, and returns null for the whole
 * record if the item doesn't belong to the user's per-company Item Group
 * (so users can't navigate to /inventory/<other-tenant-item-code> directly).
 */

const { isTenantItemGroup } = require('../erp-sync/item-group');

async function getItemDetail(user, erp, { itemCode } = {}) {
  if (!itemCode) throw new Error('itemCode required');

  let item;
  try {
    const r = await erp.getResource('Item', itemCode);
    item = r.data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }

  // Soft tenant boundary: refuse items outside the user's group.
  const abbr = user?.erpnext_company_abbr;
  if (abbr && !isTenantItemGroup(abbr, item.item_group)) {
    return null;
  }

  const isStock = !!item.is_stock_item;

  const [bins, movements, salesAppearances, purchaseAppearances, prices] = await Promise.all([
    isStock
      ? erp
          .listResource('Bin', {
            filters: [['item_code', '=', itemCode]],
            fields: ['warehouse', 'actual_qty', 'stock_uom', 'projected_qty', 'reserved_qty', 'ordered_qty', 'stock_value'],
            limit: 100,
          })
          .then((r) => r.data || [])
      : Promise.resolve([]),
    isStock
      ? erp
          .listResource('Stock Ledger Entry', {
            filters: [
              ['item_code', '=', itemCode],
              ['is_cancelled', '=', 0],
            ],
            fields: ['name', 'posting_date', 'warehouse', 'actual_qty', 'qty_after_transaction', 'voucher_type', 'voucher_no'],
            limit: 50,
            orderBy: 'posting_date desc, creation desc',
          })
          .then((r) => r.data || [])
      : Promise.resolve([]),
    erp
      .listResource('Sales Invoice Item', {
        filters: [
          ['item_code', '=', itemCode],
          ['parenttype', '=', 'Sales Invoice'],
          ['docstatus', '=', 1],
        ],
        fields: ['parent', 'qty', 'rate', 'amount', 'creation'],
        limit: 30,
        orderBy: 'creation desc',
      })
      .then((r) => r.data || [])
      .catch(() => []),
    erp
      .listResource('Purchase Invoice Item', {
        filters: [
          ['item_code', '=', itemCode],
          ['parenttype', '=', 'Purchase Invoice'],
          ['docstatus', '=', 1],
        ],
        fields: ['parent', 'qty', 'rate', 'amount', 'creation'],
        limit: 30,
        orderBy: 'creation desc',
      })
      .then((r) => r.data || [])
      .catch(() => []),
    erp
      .listResource('Item Price', {
        filters: [['item_code', '=', itemCode], ['selling', '=', 1]],
        fields: ['price_list', 'price_list_rate', 'currency'],
        limit: 10,
      })
      .then((r) => r.data || [])
      .catch(() => []),
  ]);

  const totalStock = isStock
    ? bins.reduce((s, b) => s + (Number(b.actual_qty) || 0), 0)
    : null;

  const stockValue = bins.reduce((s, b) => s + (Number(b.stock_value) || 0), 0);
  let media = {};
  try {
    media = item.media ? JSON.parse(item.media) : {};
  } catch {
    /* ignore malformed media JSON */
  }

  return {
    // Full Item doc — catalog attributes (gem_type, weight_ct, shape…) live here.
    doc: item,
    media,
    stock_value: stockValue,
    cost_rate: totalStock ? stockValue / totalStock : 0,
    selling_prices: prices.map((p) => ({ price_list: p.price_list, rate: Number(p.price_list_rate) || 0, currency: p.currency })),
    erpnext_name: item.name,
    item_code: item.item_code,
    item_name: item.item_name,
    item_group: item.item_group,
    description: item.description,
    uom: item.stock_uom,
    standard_rate: Number(item.standard_rate) || 0,
    image: item.image,
    is_stock_item: isStock,
    total_stock: totalStock,
    bins: bins.map((b) => ({
      warehouse: b.warehouse,
      actual: Number(b.actual_qty) || 0,
      projected: Number(b.projected_qty) || 0,
      reserved: Number(b.reserved_qty) || 0,
      ordered: Number(b.ordered_qty) || 0,
      uom: b.stock_uom,
    })),
    movements: movements.map((m) => ({
      erpnext_name: m.name,
      posting_date: m.posting_date,
      warehouse: m.warehouse,
      delta: Number(m.actual_qty) || 0,
      balance_after: Number(m.qty_after_transaction) || 0,
      voucher_type: m.voucher_type,
      voucher_no: m.voucher_no,
    })),
    sales_appearances: salesAppearances.map((s) => ({
      invoice: s.parent,
      qty: Number(s.qty) || 0,
      rate: Number(s.rate) || 0,
      amount: Number(s.amount) || 0,
      date: s.creation,
    })),
    purchase_appearances: purchaseAppearances.map((p) => ({
      invoice: p.parent,
      qty: Number(p.qty) || 0,
      rate: Number(p.rate) || 0,
      amount: Number(p.amount) || 0,
      date: p.creation,
    })),
  };
}

module.exports = { getItemDetail };
