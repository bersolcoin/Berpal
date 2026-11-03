/**
 * READ side — stock on hand, live from ERPNext Bins (one per item × warehouse).
 *
 * Bins carry no company, so we scope through the company's Warehouses — on a shared multi-company
 * instance that is what keeps one trader's stones out of another's answer. Item codes are shown as
 * the user's own code ("PA2293"), not the company-namespaced ERPNext name ("PA2293-TC").
 */
const { query } = require('../db');
const { round2, companyCurrency, friendlyAccountName } = require('../erp-sync/common');
const items = require('../erp-sync/items');

const FETCH_CAP = 500;

async function getStock(user, erp, { item_code = null, search = null, include_zero = false } = {}) {
  const abbr = await items.companyAbbr(erp);
  const wh = await erp.listResource('Warehouse', {
    filters: [['company', '=', erp.company], ['is_group', '=', 0]],
    fields: ['name'],
    limit: 100,
  });
  const warehouses = (wh.data || []).map((w) => w.name);
  if (!warehouses.length) return { ok: true, message: 'no_warehouse', rows: [] };

  const filters = [['warehouse', 'in', warehouses]];
  if (item_code) {
    const found = await items.findItem(user, erp, item_code);
    if (!found) return { ok: true, message: 'unknown_item', item_code: items.normalizeItemCode(item_code), rows: [] };
    filters.push(['item_code', '=', found.erpnext_name]);
  }
  if (!include_zero && !item_code) filters.push(['actual_qty', '!=', 0]);

  const r = await erp.listResource('Bin', {
    filters,
    fields: ['item_code', 'warehouse', 'actual_qty', 'valuation_rate', 'stock_value'],
    limit: FETCH_CAP,
  });
  const bins = r.data || [];

  // Names/descriptions: our cache first (no extra call), then ERPNext for items made elsewhere.
  const names = new Map();
  const cached = await query('SELECT item_code, item_name, erpnext_name FROM item_cache WHERE user_id = $1', [user.id]);
  for (const c of cached.rows) names.set(c.erpnext_name, c.item_name);
  const missing = [...new Set(bins.map((b) => b.item_code))].filter((c) => !names.has(c));
  if (missing.length) {
    const ir = await erp.listResource('Item', {
      filters: [['name', 'in', missing]], fields: ['name', 'item_name'], limit: missing.length,
    });
    for (const it of ir.data || []) names.set(it.name, it.item_name);
  }

  let rows = bins.map((b) => ({
    item_code: items.displayCode(b.item_code, abbr),
    item_name: names.get(b.item_code) || b.item_code,
    warehouse: friendlyAccountName(b.warehouse),
    qty: Number(b.actual_qty) || 0,
    valuation_rate: round2(b.valuation_rate || 0),
    stock_value: round2(b.stock_value || 0),
  }));
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((x) => x.item_code.toLowerCase().includes(q) || String(x.item_name).toLowerCase().includes(q));
  }
  rows.sort((a, b) => a.item_code.localeCompare(b.item_code) || a.warehouse.localeCompare(b.warehouse));

  return {
    ok: true,
    currency: companyCurrency(user), // valuation is always in company currency
    rows,
    total_qty: rows.reduce((s, x) => s + x.qty, 0),
    total_value: round2(rows.reduce((s, x) => s + x.stock_value, 0)),
    ...(item_code && !rows.some((x) => x.qty) ? { message: 'not_in_stock' } : {}),
  };
}

module.exports = { getStock };
