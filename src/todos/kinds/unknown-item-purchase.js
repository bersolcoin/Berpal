/**
 * Kind: unknown_item_purchase
 *
 * Triggered after a Sales Invoice saves and one of its line items has
 * no prior purchase history (no Purchase Invoice or Stock Entry has
 * ever referenced it in this tenant's Company). Accounting-wise that
 * means we're showing revenue against an item we have no cost basis
 * for — the user needs to fill in who supplied it and at what cost.
 *
 * payload shape:
 *   {
 *     item_code:     'PAR-5CT-0001',
 *     item_name:     'Paraiba 5ct',
 *     qty_sold:      1,
 *     amount_sold:   2000,
 *     currency:      'USD',
 *     invoice_ref:   'ACC-SINV-2026-00001',
 *     customer_name: 'Acme Trading',
 *   }
 *
 * Resolution (userInput shape — collected by the bot or web form):
 *   {
 *     supplier_name:    'Acme Supplies',
 *     supplier_phone:   '+12345550111' | null,
 *     unit_cost:        1500,
 *     purchase_date:    'YYYY-MM-DD' | null,
 *     skip:             true     // user said "skip / I don't remember"
 *   }
 *
 * Open-stock branch (purchase_date > 1 year ago) is teed up here but
 * not implemented yet — falls back to a normal Purchase Invoice for
 * now. We'll wire opening_stock when there's a real workflow for it.
 */

function buildPrompt(p = {}) {
  const item = p.item_name || p.item_code || 'this item';
  const sold = p.amount_sold != null && p.currency
    ? ` (sold for ${p.amount_sold} ${p.currency}${p.customer_name ? ' to ' + p.customer_name : ''})`
    : '';
  return `You sold ${item}${sold} but I don't have a purchase record for it — who did you buy it from, and for how much?`;
}

async function resolve(user, erp, payload, userInput) {
  // Placeholder. The real implementation will need to:
  //   1. Resolve/create the supplier (resolveOrCreateSupplier)
  //   2. If purchase_date > 1y ago, book Opening Stock instead of a Bill
  //   3. Otherwise create a Purchase Invoice for the item at unit_cost
  // For the first slice we just validate the input shape so the bot
  // tool round-trips cleanly; wiring the actual ERPNext write comes
  // in the next slice.
  if (userInput?.skip) {
    return { ok: true, action: 'skipped', note: 'TODO removed; no doc created.' };
  }
  if (!userInput?.supplier_name || userInput?.unit_cost == null) {
    return {
      ok: false,
      error: 'Need supplier_name AND unit_cost (or skip:true to discard the TODO).',
    };
  }
  return {
    ok: false,
    error: 'unknown_item_purchase resolution not yet implemented — slice 2 will wire the Purchase Invoice / Opening Stock write.',
    _next_slice: true,
  };
}

module.exports = {
  kind: 'unknown_item_purchase',
  bot_resolvable: true,
  web_resolvable: true,
  buildPrompt,
  resolve,
};
