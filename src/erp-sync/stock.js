/**
 * Stock-side ERPNext helpers — opening reconciliation + global settings
 * needed so the bot's flow doesn't trip on ERPNext stock validations.
 *
 *   - getDefaultWarehouse: per-tenant default ("Stores - <ABBR>"), auto
 *     created by ERPNext when the Company is provisioned with
 *     enable_perpetual_inventory=1.
 *
 *   - postOpeningStockReconciliation: writes the starting on-hand qty +
 *     valuation rate for a newly-created Item. ERPNext expects
 *     purpose='Opening Stock' for inventory that pre-dates the system.
 *
 *   - ensureAllowNegativeStock: site-wide Stock Settings toggle. Default
 *     OFF in ERPNext — that blocks any sale of an Item with on-hand=0.
 *     For our flow (sell first → backfill cost basis via the
 *     unknown_item_purchase todo), we need it ON so the first sale
 *     doesn't fail. Idempotent; runs at boot.
 */

const { ts } = require('../log');

function getDefaultWarehouseForUser(user) {
  const abbr = user?.erpnext_company_abbr;
  if (!abbr) return null;
  return `Stores - ${abbr}`;
}

/**
 * The company's "Temporary Opening" account (account_type Temporary).
 * ERPNext requires an Asset/Liability difference account on an Opening
 * Stock reconciliation — this is its standard one.
 */
async function getTemporaryOpeningAccount(erp) {
  const r = await erp.listResource('Account', {
    filters: [['company', '=', erp.company], ['account_type', '=', 'Temporary'], ['is_group', '=', 0]],
    fields: ['name'],
    limit: 1,
  });
  const name = r.data?.[0]?.name;
  if (!name) throw new Error('no Temporary Opening account for this company');
  return name;
}

/**
 * Post one Opening Stock reconciliation for several items — stock the
 * business already held before the system (not from a purchase).
 *   items: [{ itemCode, qty, valuationRate }]   qty in the item's stock UOM
 * Returns the Stock Reconciliation name; throws on failure.
 */
async function postOpeningStock(user, erp, { items, postingDate = null, warehouseOverride = null }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('postOpeningStock: items required');
  for (const it of items) {
    if (!it.itemCode) throw new Error('postOpeningStock: itemCode required');
    if (!(Number(it.qty) > 0)) throw new Error('postOpeningStock: qty must be > 0');
  }
  const warehouse = warehouseOverride || getDefaultWarehouseForUser(user);
  if (!warehouse) throw new Error('no default warehouse — tenant abbr missing');

  const payload = {
    purpose: 'Opening Stock',
    posting_date: postingDate || new Date().toISOString().slice(0, 10),
    posting_time: new Date().toISOString().slice(11, 19),
    set_posting_time: postingDate ? 1 : 0,
    company: erp.company,
    expense_account: await getTemporaryOpeningAccount(erp),
    items: items.map((it) => ({
      item_code: it.itemCode,
      warehouse,
      qty: Number(it.qty),
      valuation_rate: Number(it.valuationRate) || 0,
    })),
    docstatus: 1,
  };

  const result = await erp.createResource('Stock Reconciliation', payload);
  const docName = result.data?.name;
  console.log(`• [stock] [${ts()}] opening stock ${items.length} item(s) → ${docName}`);
  return docName;
}

/**
 * Opening on-hand for one item (kept for existing callers, e.g. the
 * unknown_item_purchase todo). Returns the SR doc name.
 */
async function postOpeningStockReconciliation(user, erp, { itemCode, qty, valuationRate = 0, warehouseOverride = null, postingDate = null }) {
  return postOpeningStock(user, erp, {
    items: [{ itemCode, qty, valuationRate }],
    postingDate,
    warehouseOverride,
  });
}

/**
 * Global Stock Settings: allow negative stock. Without this, the first
 * sale of a brand-new Item (qty on hand = 0) is rejected by ERPNext.
 * We follow up with the unknown_item_purchase todo so the user back-fills
 * cost basis. Idempotent — only PUTs if currently disabled.
 */
async function ensureAllowNegativeStock(adminErp) {
  try {
    const cur = await adminErp.getResource('Stock Settings', 'Stock Settings');
    if (cur?.data?.allow_negative_stock) {
      return false; // already on, no change
    }
    await adminErp.updateResource('Stock Settings', 'Stock Settings', {
      allow_negative_stock: 1,
    });
    console.log(`• [stock] [${ts()}] enabled allow_negative_stock site-wide`);
    return true;
  } catch (err) {
    console.warn(`• [stock] [${ts()}] ensureAllowNegativeStock failed: ${err.message}`);
    return false;
  }
}

module.exports = {
  getDefaultWarehouseForUser,
  postOpeningStock,
  postOpeningStockReconciliation,
  ensureAllowNegativeStock,
};
