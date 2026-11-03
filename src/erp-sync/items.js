/**
 * Stock Items (one per SKU / stone id the user names, e.g. "pa2293", "R-17") and the warehouse
 * they live in.
 *
 * ERPNext Items are GLOBAL across Companies, but this bot runs N Companies on one instance, so a
 * user's "PA2293" is stored as Item "PA2293-<abbr>" — two traders with the same stone id never
 * share an Item (and its name/description). The `item_cache` row maps the user's code to the
 * ERPNext name; Bins (stock per warehouse) are company-scoped through their Warehouse anyway.
 *
 * Untracked lines (services, misc) keep using GEN-SALE / GEN-PURCHASE (common.ensureGenericItem).
 */
const { query } = require('../db');
const { ts } = require('./common');

const ITEM_GROUP = 'Products';

/**
 * The cache / ERPNext key for a stone id: NFKC (full-width ｐａ２２９３ folds to PA2293), upper-cased, letters (any script — Thai included),
 * combining marks (Thai vowels and tone marks are marks, so ทับทิม ≠ ทบทม) and digits only.
 * "pa2293" / "PA-2293" / "pa 2293" → "PA2293"; "ทับทิม01" and "ไพลิน01" stay distinct.
 * Separators are dropped, so "A-12" and "A1-2" are the same key — the code as typed is kept in
 * item_name (displayItemCode) so a printout still shows it.
 * '/' is refused upstream (itemCodeProblem) — it breaks ERPNext URLs and usually means two ids.
 */
function normalizeItemCode(code) {
  return String(code || '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '').slice(0, 120);
}

/** The code as the user typed it, tidied: "pa-2293 " → "PA-2293". */
function displayItemCode(code) {
  return String(code || '').normalize('NFKC').toUpperCase().trim().replace(/\s+/g, ' ').slice(0, 120);
}

/** Why a raw item_code can't be used, or null. */
function itemCodeProblem(raw) {
  if (String(raw).includes('/')) return `item_code "${raw}" contains '/'; use one stock id per line`;
  if (!normalizeItemCode(raw)) return `item_code "${raw}" has no letters or digits`;
  return null;
}

/** Company abbreviation ("TC"), per-process memo — it never changes once a company has entries. */
const _abbrCache = new Map();
async function companyAbbr(erp) {
  if (_abbrCache.has(erp.company)) return _abbrCache.get(erp.company);
  const r = await erp.getResource('Company', erp.company);
  const abbr = r.data?.abbr;
  if (!abbr) throw new Error(`[erpnext] company ${erp.company} has no abbreviation`);
  _abbrCache.set(erp.company, abbr);
  return abbr;
}

/** ERPNext Item name → the user's code ("PA2293-TC" → "PA2293"). */
function displayCode(erpName, abbr) {
  const suffix = `-${abbr}`;
  return erpName.endsWith(suffix) ? erpName.slice(0, -suffix.length) : erpName;
}

/**
 * Warehouse stock goes in/out of: Stock Settings' default warehouse when it belongs to this
 * company (the setup wizard sets it to the FIRST company's Stores), else "Stores - <abbr>"
 * (created for every company), else any leaf warehouse of the company.
 */
const _warehouseCache = new Map();
async function resolveWarehouse(erp) {
  if (_warehouseCache.has(erp.company)) return _warehouseCache.get(erp.company);
  const abbr = await companyAbbr(erp);
  const settings = await stockSettings(erp);
  const candidates = [settings.default_warehouse, `Stores - ${abbr}`].filter(Boolean);
  let found = null;
  for (const name of candidates) {
    const r = await erp.listResource('Warehouse', {
      filters: [['name', '=', name], ['company', '=', erp.company], ['is_group', '=', 0]],
      fields: ['name'],
      limit: 1,
    });
    if (r.data?.length) {
      found = r.data[0].name;
      break;
    }
  }
  if (!found) {
    const any = await erp.listResource('Warehouse', {
      filters: [['company', '=', erp.company], ['is_group', '=', 0]],
      fields: ['name'],
      limit: 1,
    });
    found = any.data?.[0]?.name || null;
  }
  if (!found) throw new Error(`[erpnext] company ${erp.company} has no warehouse; create "Stores - ${abbr}"`);
  _warehouseCache.set(erp.company, found);
  return found;
}

/** Stock Settings single doc. Not memoized: allow_negative_stock is an admin toggle. */
async function stockSettings(erp) {
  try {
    const r = await erp.getResource('Stock Settings', 'Stock Settings');
    return r.data || {};
  } catch (err) {
    if (err.status === 403 || err.status === 404) return {};
    throw err;
  }
}

/** Make sure the "Products" Item Group exists (fresh sites have it; bare ones may not). */
let _groupEnsured = false;
async function ensureItemGroup(erp) {
  if (_groupEnsured) return;
  try {
    await erp.getResource('Item Group', ITEM_GROUP);
  } catch (err) {
    if (err.status !== 404) throw err;
    await erp.createResource('Item Group', {
      item_group_name: ITEM_GROUP, parent_item_group: 'All Item Groups', is_group: 0,
    });
    console.log(`• [erp-sync] [${ts()}] created Item Group ${ITEM_GROUP}`);
  }
  _groupEnsured = true;
}

async function cachedItem(user, code) {
  const r = await query('SELECT * FROM item_cache WHERE user_id = $1 AND item_code = $2', [user.id, code]);
  return r.rows[0] || null;
}

/** Look up a user's item without creating it. Returns { item_code, erpnext_name } or null. */
async function findItem(user, erp, rawCode) {
  const code = normalizeItemCode(rawCode);
  if (!code) return null;
  const hit = await cachedItem(user, code);
  if (hit) return { item_code: code, erpnext_name: hit.erpnext_name, item_name: hit.item_name };
  const erpName = `${code}-${await companyAbbr(erp)}`;
  try {
    const r = await erp.getResource('Item', erpName);
    return { item_code: code, erpnext_name: r.data.name, item_name: r.data.item_name };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Find or create the stock Item for a user's code. Cache → ERPNext GET → create.
 * Returns { item_code, erpnext_name, is_stock_item }.
 */
async function resolveItem(user, erp, { item_code, description }) {
  const problem = itemCodeProblem(item_code);
  if (problem) throw new Error(problem);
  const code = normalizeItemCode(item_code);
  const hit = await cachedItem(user, code);
  if (hit) return { item_code: code, erpnext_name: hit.erpnext_name, is_stock_item: 1 };

  const erpName = `${code}-${await companyAbbr(erp)}`;
  let doc = null;
  try {
    doc = (await erp.getResource('Item', erpName)).data;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (!doc) {
    await ensureItemGroup(erp);
    // item_name is what shows on printouts and lists; keep the user's code up front so a
    // search for "pa2293" finds it, with the stone description after it.
    const shown = displayItemCode(item_code);
    const itemName = description ? `${shown} ${description}`.slice(0, 140) : shown;
    doc = (await erp.createResource('Item', {
      item_code: erpName,
      item_name: itemName,
      description: description || code,
      item_group: ITEM_GROUP,
      stock_uom: 'Nos',
      is_stock_item: 1,
      is_sales_item: 1,
      is_purchase_item: 1,
      include_item_in_manufacturing: 0,
    })).data;
    console.log(`• [erp-sync] [${ts()}] created stock Item ${erpName} in ERPNext`);
  }
  await query(
    `INSERT INTO item_cache (user_id, item_code, item_name, erpnext_name, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, item_code) DO UPDATE SET erpnext_name = EXCLUDED.erpnext_name`,
    [user.id, code, doc.item_name || code, doc.name, new Date().toISOString()]
  );
  return { item_code: code, erpnext_name: doc.name, is_stock_item: doc.is_stock_item ? 1 : 0 };
}

/** Bin for an ERPNext item in a warehouse: { actual_qty, valuation_rate } (zeros when none yet). */
async function binFor(erp, erpName, warehouse) {
  const r = await erp.listResource('Bin', {
    filters: [['item_code', '=', erpName], ['warehouse', '=', warehouse]],
    fields: ['actual_qty', 'valuation_rate'],
    limit: 1,
  });
  const b = r.data?.[0] || {};
  return { actual_qty: Number(b.actual_qty) || 0, valuation_rate: Number(b.valuation_rate) || 0 };
}

/**
 * Lowest running balance of an item in a warehouse from the end of `date` onward, through every
 * later Stock Ledger Entry. That is what ERPNext checks for a (back-dated) issue: the sale lowers
 * every later balance too, so it must not push any of them below zero.
 */
async function minQtyFrom(erp, erpName, warehouse, date, time = new Date().toTimeString().slice(0, 8)) {
  const r = await erp.listResource('Stock Ledger Entry', {
    filters: [['item_code', '=', erpName], ['warehouse', '=', warehouse], ['is_cancelled', '=', 0]],
    fields: ['posting_date', 'posting_time', 'creation', 'actual_qty'],
    limit: 10000,
  });
  // ERPNext sequences entries by posting date, then posting time, then creation. The new sale is
  // stamped with the current time (we send set_posting_time without a time), so same-day entries
  // after that time are "later" ones it must not push negative.
  const key = (e) => `${e.posting_date} ${e.posting_time || '00:00:00'} ${e.creation || ''}`;
  const sles = (r.data || []).sort((a, b) => key(a).localeCompare(key(b)));
  const at = `${date} ${time}`;
  const before = (e) => `${e.posting_date} ${e.posting_time || '00:00:00'}` <= at;
  let bal = 0;
  for (const e of sles) if (before(e)) bal += Number(e.actual_qty) || 0;
  let min = bal;
  for (const e of sles) {
    if (before(e)) continue;
    bal += Number(e.actual_qty) || 0;
    min = Math.min(min, bal);
  }
  return min;
}

/**
 * Pre-flight for a sale: every stock line must be available, so the bot can explain BEFORE the
 * user taps Confirm instead of ERPNext failing the submit.
 *   - Available = the lowest running balance from the posting date on (minQtyFrom), so a
 *     back-dated sale that would make a later point negative is refused like ERPNext refuses it.
 *   - allow_negative_stock lets a short sale through only if the item has a valuation rate:
 *     ERPNext can't book COGS for an item that was never valued ("Valuation Rate Missing").
 * Returns an error string or null.
 */
async function stockShortfall(user, erp, items, postingDate = null) {
  const stockLines = (items || []).filter((it) => it.item_code);
  if (!stockLines.length) return null;
  const settings = await stockSettings(erp);
  const allowNegative = !!Number(settings.allow_negative_stock);
  const warehouse = await resolveWarehouse(erp);
  const today = new Date().toISOString().slice(0, 10);
  const date = postingDate || today;
  const need = new Map();
  for (const it of stockLines) {
    const code = normalizeItemCode(it.item_code);
    need.set(code, (need.get(code) || 0) + (it.qty == null ? 1 : Number(it.qty)));
  }
  for (const [code, qty] of need) {
    const item = await findItem(user, erp, code);
    const have = item ? await minQtyFrom(erp, item.erpnext_name, warehouse, date) : 0;
    if (have >= qty) continue;
    const when = date < today ? ` on ${date} (or a later date it was already sold)` : '';
    if (!allowNegative) {
      return `${code} is not in stock${when} (${have} available, selling ${qty}). Tell the user; they must log its purchase first (bill_received with this item_code, dated on or before the sale) — or drop item_code to record an untracked sale.`;
    }
    const bin = item ? await binFor(erp, item.erpnext_name, warehouse) : { valuation_rate: 0 };
    if (!bin.valuation_rate) {
      return `${code} has never been bought, so it has no cost to book against the sale (ERPNext: Valuation Rate Missing). Log its purchase first, or drop item_code to record an untracked sale.`;
    }
  }
  return null;
}

/** Forget memoised warehouse / abbreviation for a company (after a failed save). */
function clearCaches(company) {
  _warehouseCache.delete(company);
  _abbrCache.delete(company);
  _groupEnsured = false;
}

module.exports = {
  ITEM_GROUP, normalizeItemCode, displayItemCode, itemCodeProblem, companyAbbr, displayCode, resolveWarehouse, stockSettings,
  findItem, resolveItem, binFor, minQtyFrom, stockShortfall, clearCaches,
};
