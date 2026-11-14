/**
 * List ERPNext Items, optionally filtered by stock-vs-service.
 * For stock items we also pull Bin records and roll up total stock.
 *
 * Multi-tenancy: Items aren't strictly company-scoped in ERPNext (site-wide
 * doctype). We tag every item with a per-company Item Group ("Items - <ABBR>")
 * during creation and filter list queries by it. Soft isolation — adequate
 * for our UI; a future pass will harden with ERPNext User Permissions.
 *
 * If the user doesn't have an abbr (legacy users from before this column
 * existed), we fall back to listing every non-disabled item — same as before.
 *
 * Returns { rows, hasMore } for pagination.
 */

const { tenantItemGroupFilter } = require('../erp-sync/item-group');

async function listItems(user, erp, { isStockItem, limit = 50, offset = 0 } = {}) {
  const filters = [['disabled', '=', 0]];
  if (isStockItem === true) filters.push(['is_stock_item', '=', 1]);
  if (isStockItem === false) filters.push(['is_stock_item', '=', 0]);

  filters.push(...tenantItemGroupFilter(user?.erpnext_company_abbr));

  const itemsResult = await erp.listResource('Item', {
    filters,
    fields: [
      'name',
      'item_code',
      'item_name',
      'item_group',
      'stock_uom',
      'standard_rate',
      'image',
      'is_stock_item',
      'modified',
    ],
    limit: limit + offset + 1,
    orderBy: 'modified desc',
  });

  const allItems = itemsResult.data || [];

  // Stock rollup: one Bin call covers all items in this slice.
  let binsByItem = new Map();
  if (isStockItem === true && allItems.length > 0) {
    const codes = allItems.map((i) => i.item_code);
    const binsResult = await erp.listResource('Bin', {
      filters: [['item_code', 'in', codes]],
      fields: ['item_code', 'warehouse', 'actual_qty', 'stock_uom'],
      limit: 500,
    });
    for (const bin of binsResult.data || []) {
      if (!binsByItem.has(bin.item_code)) binsByItem.set(bin.item_code, []);
      binsByItem.get(bin.item_code).push(bin);
    }
  }

  const enriched = allItems.map((item) => {
    const bins = binsByItem.get(item.item_code) || [];
    const totalStock = bins.reduce((s, b) => s + (Number(b.actual_qty) || 0), 0);
    return {
      erpnext_name: item.name,
      item_code: item.item_code,
      item_name: item.item_name,
      item_group: item.item_group,
      uom: item.stock_uom,
      standard_rate: Number(item.standard_rate) || 0,
      image: item.image,
      is_stock_item: !!item.is_stock_item,
      total_stock: isStockItem === true ? totalStock : null,
      bins,
      modified: item.modified,
    };
  });

  const page = enriched.slice(offset, offset + limit + 1);
  const hasMore = page.length > limit;
  return { rows: page.slice(0, limit), hasMore };
}

async function countItems(user, erp, { isStockItem } = {}) {
  const filters = [['disabled', '=', 0]];
  if (isStockItem === true) filters.push(['is_stock_item', '=', 1]);
  if (isStockItem === false) filters.push(['is_stock_item', '=', 0]);
  filters.push(...tenantItemGroupFilter(user?.erpnext_company_abbr));
  const r = await erp.callMethod('frappe.client.get_count', {
    doctype: 'Item',
    filters,
  });
  return Number(r.message) || 0;
}

module.exports = { listItems, countItems };
