/**
 * Merged recent-transactions stream across the four accounting doctypes
 * the bot can produce: Sales Invoice, Purchase Invoice, Payment Entry,
 * Journal Entry. Sorted newest-first by posting_date (then by `name` for
 * stable order within a date).
 *
 * Returns:
 *   {
 *     rows: [{
 *       doctype, erpnext_name, kind, party, posting_date,
 *       currency, amount, status, raw
 *     }, ...],
 *     hasMore: boolean
 *   }
 *
 * `kind` is a friendly label: 'Invoice', 'Purchase', 'Expense', 'Cash',
 * 'Receipt', 'Payment'. `party` is the customer / supplier when applicable.
 *
 * Pagination model: pass `offset` to skip rows, `limit` for page size.
 * Because we merge four streams and re-sort client-side, each doctype
 * is fetched up to `limit + offset + 1` from ERPNext — fine for typical
 * small-business volumes, gets inefficient past page 20+.
 */

const DEFAULT_LIMIT_PER_DOCTYPE = 50;

async function listRecentTransactions(user, erp, { limit = 25, offset = 0 } = {}) {
  const perType = Math.max(limit + offset + 1, DEFAULT_LIMIT_PER_DOCTYPE);

  const [si, pi, pe, je] = await Promise.all([
    erp.listResource('Sales Invoice', {
      filters: [['company', '=', erp.company], ['docstatus', '!=', 2]],
      fields: ['name', 'customer', 'posting_date', 'currency', 'grand_total', 'outstanding_amount', 'status', 'docstatus'],
      limit: perType,
      orderBy: 'posting_date desc, name desc',
    }),
    erp.listResource('Purchase Invoice', {
      filters: [['company', '=', erp.company], ['docstatus', '!=', 2]],
      fields: ['name', 'supplier', 'posting_date', 'currency', 'grand_total', 'outstanding_amount', 'status', 'docstatus'],
      limit: perType,
      orderBy: 'posting_date desc, name desc',
    }),
    erp.listResource('Payment Entry', {
      filters: [['company', '=', erp.company], ['docstatus', '!=', 2]],
      fields: [
        'name', 'payment_type', 'party_type', 'party',
        'posting_date', 'paid_amount',
        'paid_from_account_currency', 'paid_to_account_currency',
        'docstatus',
      ],
      limit: perType,
      orderBy: 'posting_date desc, name desc',
    }),
    erp.listResource('Journal Entry', {
      filters: [['company', '=', erp.company], ['docstatus', '!=', 2]],
      fields: ['name', 'title', 'posting_date', 'total_debit', 'docstatus'],
      limit: perType,
      orderBy: 'posting_date desc, name desc',
    }),
  ]);

  const rows = [];

  for (const r of si.data || []) {
    rows.push({
      doctype: 'Sales Invoice',
      erpnext_name: r.name,
      kind: 'Invoice',
      party: r.customer,
      posting_date: r.posting_date,
      currency: r.currency,
      amount: Number(r.grand_total) || 0,
      outstanding: Number(r.outstanding_amount) || 0,
      status: r.docstatus === 0 ? 'Draft' : (r.status || 'Submitted'),
      raw: r,
    });
  }
  for (const r of pi.data || []) {
    rows.push({
      doctype: 'Purchase Invoice',
      erpnext_name: r.name,
      kind: 'Purchase',
      party: r.supplier,
      posting_date: r.posting_date,
      currency: r.currency,
      amount: Number(r.grand_total) || 0,
      outstanding: Number(r.outstanding_amount) || 0,
      status: r.docstatus === 0 ? 'Draft' : (r.status || 'Submitted'),
      raw: r,
    });
  }
  for (const r of pe.data || []) {
    rows.push({
      doctype: 'Payment Entry',
      erpnext_name: r.name,
      kind: r.payment_type === 'Receive' ? 'Receipt' : 'Payment',
      party: r.party,
      posting_date: r.posting_date,
      currency: r.payment_type === 'Receive' ? r.paid_from_account_currency : r.paid_to_account_currency,
      amount: Number(r.paid_amount) || 0,
      outstanding: 0,
      status: r.docstatus === 0 ? 'Draft' : 'Submitted',
      raw: r,
    });
  }
  for (const r of je.data || []) {
    const isExpense = /expense|bill|cost/i.test(r.title || '');
    rows.push({
      doctype: 'Journal Entry',
      erpnext_name: r.name,
      kind: isExpense ? 'Expense' : 'Cash',
      party: null,
      posting_date: r.posting_date,
      currency: null,
      amount: Number(r.total_debit) || 0,
      outstanding: 0,
      status: r.docstatus === 0 ? 'Draft' : 'Submitted',
      raw: { ...r, title: r.title },
    });
  }

  rows.sort((a, b) => {
    const da = a.posting_date || '';
    const db = b.posting_date || '';
    if (da !== db) return db.localeCompare(da);
    return (b.erpnext_name || '').localeCompare(a.erpnext_name || '');
  });

  // Slice and detect hasMore by fetching one extra row.
  const page = rows.slice(offset, offset + limit + 1);
  const hasMore = page.length > limit;
  return { rows: page.slice(0, limit), hasMore };
}

/**
 * Total transaction count across the four doctypes for the user's company.
 * Used for numbered pagination. Single Promise.all so the four calls run
 * in parallel.
 */
async function countRecentTransactions(user, erp) {
  const baseFilters = [['company', '=', erp.company], ['docstatus', '!=', 2]];

  const callCount = (doctype, filters = baseFilters) =>
    erp.callMethod('frappe.client.get_count', {
      doctype,
      filters,
    });

  const [si, pi, pe, je] = await Promise.all([
    callCount('Sales Invoice'),
    callCount('Purchase Invoice'),
    callCount('Payment Entry'),
    callCount('Journal Entry'),
  ]);

  return (
    (Number(si.message) || 0) +
    (Number(pi.message) || 0) +
    (Number(pe.message) || 0) +
    (Number(je.message) || 0)
  );
}

module.exports = { listRecentTransactions, countRecentTransactions };
