/**
 * Inventory table data — every stocked lot of this tenant with its catalog
 * attributes, on-hand stock, valuation, selling price, media and stock
 * status. Returns all lots matching the search; the page sorts, filters
 * (Excel-style, per column) and pages them.
 *
 *   listInventory(user, erp, { q }) → rows
 *
 * Search (q) matches code, name or variety. Status (in stock / partly sold
 * / sold) comes from on-hand stock (Bin, summed across warehouses).
 * Selling price from Item Price (first selling price list found per item,
 * in its own currency).
 */

const { tenantItemGroupFilter } = require('../erp-sync/item-group');

const ATTR_FIELDS = [
  'gem_family', 'gem_type', 'pieces', 'weight_ct', 'shape', 'base_color', 'color', 'trade_name',
  'clarity', 'treatment', 'origin', 'cut', 'meas1', 'meas2', 'meas3', 'lab', 'certificate_no',
  'parcel_type', 'calibrated', 'media',
];
const FIELDS = ['name', 'item_code', 'item_name', 'image', 'stock_uom', 'creation', ...ATTR_FIELDS];

const parseJson = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

/**
 * Stock status from what's left: none → sold; less than the lot's weight
 * (carat lots) → partly sold; otherwise in stock.
 */
function stockStatus(qty, weight, uom) {
  if (!(qty > 0)) return 'sold';
  if (uom === 'Carat' && weight > 0 && qty < weight - 1e-6) return 'partly_sold';
  return 'in_stock';
}

async function listInventory(user, erp, { q = '' } = {}) {
  const base = [['disabled', '=', 0], ['is_stock_item', '=', 1], ...tenantItemGroupFilter(user.erpnext_company_abbr)];
  const term = String(q || '').trim();

  let items;
  if (term) {
    // ERPNext REST has no OR — one query per searchable field, merged.
    const hits = await Promise.all(
      ['item_code', 'item_name', 'gem_type'].map((f) =>
        erp.listResource('Item', { filters: [...base, [f, 'like', `%${term}%`]], fields: FIELDS, limit: 0 })
      )
    );
    const m = new Map();
    for (const h of hits) for (const r of h.data || []) m.set(r.name, r);
    items = [...m.values()];
  } else {
    items = (await erp.listResource('Item', { filters: base, fields: FIELDS, limit: 0 })).data || [];
  }
  // Newest first unless the user sorts.
  items.sort((a, b) => (a.creation < b.creation ? 1 : -1));
  if (!items.length) return [];

  const names = items.map((it) => it.name);
  const [bins, prices] = await Promise.all([
    erp.listResource('Bin', {
      filters: [['item_code', 'in', names]],
      fields: ['item_code', 'actual_qty', 'stock_value'],
      limit: 0,
    }),
    erp.listResource('Item Price', {
      filters: [['item_code', 'in', names], ['selling', '=', 1]],
      fields: ['item_code', 'price_list_rate', 'currency'],
      limit: 0,
    }),
  ]);
  const stock = new Map();
  for (const b of bins.data || []) {
    const cur = stock.get(b.item_code) || { qty: 0, value: 0 };
    cur.qty += Number(b.actual_qty) || 0;
    cur.value += Number(b.stock_value) || 0;
    stock.set(b.item_code, cur);
  }
  const price = new Map();
  for (const p of prices.data || []) if (!price.has(p.item_code)) price.set(p.item_code, p);

  return items.map((it) => {
    const st = stock.get(it.name) || { qty: 0, value: 0 };
    const pr = price.get(it.name);
    return {
      ...it,
      media: parseJson(it.media) || {},
      qty: st.qty,
      status: stockStatus(st.qty, Number(it.weight_ct) || 0, it.stock_uom),
      stock_value: st.value,
      cost_rate: st.qty ? st.value / st.qty : 0,
      selling_price: pr ? Number(pr.price_list_rate) || 0 : null,
      selling_currency: pr?.currency || null,
    };
  });
}

/** Totals over a set of rows (all pages): lots, in stock, carats + pieces on hand, value. */
function inventoryTotals(rows) {
  const inStock = rows.filter((r) => r.status !== 'sold');
  return {
    lots: rows.length,
    in_stock: inStock.length,
    qty: inStock.reduce((s, r) => s + (r.stock_uom === 'Carat' ? r.qty : 0), 0),
    pieces: inStock.reduce((s, r) => s + (Number(r.pieces) || 0), 0),
    value: rows.reduce((s, r) => s + r.stock_value, 0),
  };
}

module.exports = { listInventory, inventoryTotals };
