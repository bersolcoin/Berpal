/**
 * What does this counterparty owe us, or what do we owe them?
 *
 * For Customer: sum(outstanding on open Sales Invoices) − sum(unallocated on Payment Entries)
 *               positive = they owe us; negative = we hold their money (advance)
 * For Supplier: sum(outstanding on open Purchase Invoices) − sum(unallocated on Payment Entries)
 *               positive = we owe them; negative = we paid in advance
 *
 * Aggregates per-currency (multi-currency businesses keep separate buckets so
 * a USD advance doesn't silently offset a THB outstanding).
 *
 * Returns:
 *   {
 *     partyType, partyName,
 *     netByCurrency: { USD: 7000, THB: 0, ... }   // outstanding minus advances
 *     totals: { outstandingByCurrency, advancesByCurrency }
 *     invoiceCount, advanceCount,
 *     invoices: [{...}],   advances: [{...}]      // raw rows for the LLM to reference
 *   }
 */

async function getBalanceWithCounterparty(user, erp, { partyType, partyName }) {
  if (partyType !== 'Customer' && partyType !== 'Supplier') {
    throw new Error(`partyType must be 'Customer' or 'Supplier', got: ${partyType}`);
  }
  if (!partyName) throw new Error('partyName is required');

  const isCustomer = partyType === 'Customer';
  const invoiceDoctype = isCustomer ? 'Sales Invoice' : 'Purchase Invoice';
  const partyField = isCustomer ? 'customer' : 'supplier';

  // 1. Open invoices for this party.
  const invResult = await erp.listResource(invoiceDoctype, {
    filters: [
      ['company', '=', erp.company],
      [partyField, '=', partyName],
      ['docstatus', '=', 1],
      ['outstanding_amount', '>', 0],
    ],
    fields: [
      'name',
      'currency',
      'outstanding_amount',
      'grand_total',
      'posting_date',
      'due_date',
    ],
    limit: 100,
    orderBy: 'posting_date asc',
  });

  // 2. Payment Entries with unallocated balance for this party (= advances on file).
  const pmtResult = await erp.listResource('Payment Entry', {
    filters: [
      ['company', '=', erp.company],
      ['party_type', '=', partyType],
      ['party', '=', partyName],
      ['docstatus', '=', 1],
      ['unallocated_amount', '>', 0],
    ],
    fields: [
      'name',
      'paid_from_account_currency',
      'paid_to_account_currency',
      'unallocated_amount',
      'paid_amount',
      'posting_date',
    ],
    limit: 100,
    orderBy: 'posting_date asc',
  });

  // 3. Aggregate per currency.
  const outstandingByCurrency = {};
  const advancesByCurrency = {};

  for (const inv of invResult.data || []) {
    const ccy = inv.currency;
    outstandingByCurrency[ccy] = (outstandingByCurrency[ccy] || 0) + (inv.outstanding_amount || 0);
  }

  for (const pmt of pmtResult.data || []) {
    // For a Customer "Receive": paid_from is the AR (party) account, currency = invoice currency
    // For a Supplier "Pay":     paid_to is the AP (party) account, currency = invoice currency
    const ccy = isCustomer
      ? pmt.paid_from_account_currency
      : pmt.paid_to_account_currency;
    if (!ccy) continue;
    advancesByCurrency[ccy] = (advancesByCurrency[ccy] || 0) + (pmt.unallocated_amount || 0);
  }

  const allCurrencies = new Set([
    ...Object.keys(outstandingByCurrency),
    ...Object.keys(advancesByCurrency),
  ]);
  const netByCurrency = {};
  for (const ccy of allCurrencies) {
    const net = (outstandingByCurrency[ccy] || 0) - (advancesByCurrency[ccy] || 0);
    // Drop near-zero balances (sub-cent) so the LLM doesn't render "0 USD"
    if (Math.abs(net) > 0.005) netByCurrency[ccy] = net;
    else netByCurrency[ccy] = 0;
  }

  return {
    partyType,
    partyName,
    netByCurrency,
    totals: { outstandingByCurrency, advancesByCurrency },
    invoiceCount: invResult.data?.length || 0,
    advanceCount: pmtResult.data?.length || 0,
    invoices: (invResult.data || []).map((i) => ({
      erpnext_name: i.name,
      currency: i.currency,
      outstanding_amount: i.outstanding_amount,
      grand_total: i.grand_total,
      posting_date: i.posting_date,
      due_date: i.due_date,
    })),
    advances: (pmtResult.data || []).map((p) => ({
      erpnext_name: p.name,
      currency: isCustomer ? p.paid_from_account_currency : p.paid_to_account_currency,
      unallocated_amount: p.unallocated_amount,
      posting_date: p.posting_date,
    })),
  };
}

module.exports = { getBalanceWithCounterparty };
