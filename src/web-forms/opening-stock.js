/**
 * Web "Opening stock" form → new lots + one ERPNext Opening Stock
 * reconciliation. For stock the business already holds that didn't come
 * through a purchase in Caratpal (stones on hand at sign-up, lots brought
 * over from an old system). Valued at the cost entered, in the company
 * currency, against the Temporary Opening account.
 *
 * Payload:
 *   {
 *     date: 'YYYY-MM-DD',                     // "as of"
 *     lots: [{
 *       variety, code?, attributes,           // same as a new lot in a purchase
 *       qty?,                                 // non-carat categories (pieces/grams)
 *       rate,                                 // cost per unit (per ct for gems)
 *     }]
 *   }
 * Returns { ok: true, lots: [{ erpnext_name, item_code }], stock_entry } or { ok: false, error }.
 */

const { createLot } = require('../catalog');
const { postOpeningStock } = require('../erp-sync/stock');
const { ts } = require('../log');

async function createOpeningStock(user, erp, body) {
  const date = String(body?.date || '').trim();
  const lots = Array.isArray(body?.lots) ? body.lots : [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Pick the “as of” date.' };
  if (lots.length === 0) return { ok: false, error: 'Add at least one lot.' };
  for (const [i, l] of lots.entries()) {
    if (!l?.variety) return { ok: false, error: `Lot ${i + 1}: choose a variety.` };
    if (!(Number(l.rate) >= 0) || l.rate === '' || l.rate == null) return { ok: false, error: `Lot ${i + 1}: enter the cost.` };
  }

  // Create every lot first; stock goes in one reconciliation afterwards.
  const created = [];
  for (const [i, l] of lots.entries()) {
    try {
      const lot = await createLot(user, erp, {
        variety: l.variety,
        code: l.code ? String(l.code).trim() : null,
        attributes: l.attributes || {},
      });
      const qty = lot.uom === 'Carat' ? lot.weight_ct : Number(l.qty);
      if (!(qty > 0)) return { ok: false, error: `Lot ${i + 1}: enter the quantity.`, created };
      created.push({ erpnext_name: lot.erpnext_name, item_code: lot.item_code, qty, rate: Number(l.rate) });
    } catch (err) {
      const msg = err.userMessage || (/already exists|Duplicate/i.test(err.message) ? `lot code "${l.code}" already exists` : null);
      if (msg) return { ok: false, error: `Lot ${i + 1}: ${msg}`, created };
      throw err;
    }
  }

  let stockEntry;
  try {
    stockEntry = await postOpeningStock(user, erp, {
      items: created.map((c) => ({ itemCode: c.erpnext_name, qty: c.qty, valuationRate: c.rate })),
      postingDate: date,
    });
  } catch (err) {
    console.error(`[opening-stock] reconciliation failed after creating ${created.length} lot(s):`, err.message);
    return {
      ok: false,
      error: `Lots were created but their stock couldn’t be recorded: ${String(err.message).replace(/<[^>]+>/g, '').slice(0, 200)}`,
      created,
    };
  }

  console.log(`• [opening-stock] [${ts()}] user=${user.id} ${created.length} lot(s) → ${stockEntry}`);
  return { ok: true, lots: created.map(({ erpnext_name, item_code }) => ({ erpnext_name, item_code })), stock_entry: stockEntry };
}

module.exports = { createOpeningStock };
