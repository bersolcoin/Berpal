/**
 * Query ERPNext for open invoices (unpaid Sales Invoices or Purchase Invoices)
 * for a given customer/supplier, or across the company.
 *
 *   direction:           'receivable' = Sales Invoices (customer owes us)
 *                        'payable'    = Purchase Invoices (we owe supplier)
 *   counterpartyName?:   filter to this customer/supplier by name (optional)
 *   limit?:              page size, default 20
 *
 * Returns:
 *   [
 *     {
 *       doctype: 'Sales Invoice',
 *       erpnext_name: 'ACC-SINV-2026-00001',
 *       counterparty: 'Jameel Crest Gems',
 *       posting_date: '2026-05-12',
 *       due_date: '2026-06-11',
 *       currency: 'USD',
 *       grand_total: 45000,
 *       outstanding_amount: 45000,
 *       conversion_rate: 32.1,
 *       status: 'Unpaid',
 *     },
 *     …
 *   ]
 *
 * "Open" means outstanding_amount > 0 AND docstatus = 1 (submitted/active).
 */

async function listOpenInvoices(user, erp, { direction, counterpartyName = null, limit = 20 } = {}) {
  if (direction !== 'receivable' && direction !== 'payable') {
    throw new Error(`listOpenInvoices: direction must be 'receivable' or 'payable', got: ${direction}`);
  }

  const doctype = direction === 'receivable' ? 'Sales Invoice' : 'Purchase Invoice';
  const partyField = direction === 'receivable' ? 'customer' : 'supplier';

  const filters = [
    ['company', '=', erp.company],
    ['docstatus', '=', 1],
    ['outstanding_amount', '>', 0],
  ];
  if (counterpartyName) {
    filters.push([partyField, '=', counterpartyName]);
  }

  const r = await erp.listResource(doctype, {
    filters,
    fields: [
      'name',
      partyField,
      'posting_date',
      'due_date',
      'currency',
      'grand_total',
      'outstanding_amount',
      'conversion_rate',
      'status',
    ],
    limit,
    orderBy: 'posting_date asc',
  });

  return (r.data || []).map((row) => ({
    doctype,
    erpnext_name: row.name,
    counterparty: row[partyField],
    posting_date: row.posting_date,
    due_date: row.due_date,
    currency: row.currency,
    grand_total: row.grand_total,
    outstanding_amount: row.outstanding_amount,
    conversion_rate: row.conversion_rate,
    status: row.status,
  }));
}

module.exports = { listOpenInvoices };
