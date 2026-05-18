/**
 * List all customers with their open AR balance, summarized per currency.
 *
 *   [
 *     {
 *       erpnext_name, customer_name, mobile_no, default_currency,
 *       outstanding_by_currency: { USD: 14000, THB: 0 },
 *       open_invoice_count
 *     }, ...
 *   ]
 *
 * Approach: 1 call to list Customers + 1 call to list all open Sales Invoices
 * for the company. Group invoice outstanding by customer + currency. Avoids
 * the N+1 trap of calling get_balance_on per customer.
 *
 * Sort: customers with non-zero AR first (descending by total outstanding in
 * the user's reporting currency, fallback to the first currency we see),
 * then alphabetical for the rest.
 */

const { query } = require('../db');

async function listCustomersWithAR(user, erp, { limit = 200 } = {}) {
  const [custResult, invResult, linksResult] = await Promise.all([
    erp.listResource('Customer', {
      fields: ['name', 'customer_name', 'mobile_no', 'email_id', 'default_currency', 'customer_group'],
      limit,
      orderBy: 'customer_name asc',
    }),
    erp.listResource('Sales Invoice', {
      filters: [
        ['company', '=', erp.company],
        ['docstatus', '=', 1],
        ['outstanding_amount', '>', 0],
      ],
      fields: ['customer', 'currency', 'outstanding_amount'],
      limit: 500,
    }),
    query(
      `SELECT erpnext_name, linked_user_id FROM counterparty_cache
         WHERE owner_user_id = $1 AND erpnext_doctype = 'Customer'
           AND linked_user_id IS NOT NULL`,
      [user.id]
    ),
  ]);

  const linkedByErpName = new Map();
  for (const row of linksResult.rows || []) {
    linkedByErpName.set(row.erpnext_name, row.linked_user_id);
  }

  const byCustomer = new Map();
  for (const inv of invResult.data || []) {
    if (!byCustomer.has(inv.customer)) {
      byCustomer.set(inv.customer, { total: {}, count: 0 });
    }
    const slot = byCustomer.get(inv.customer);
    slot.total[inv.currency] = (slot.total[inv.currency] || 0) + (inv.outstanding_amount || 0);
    slot.count += 1;
  }

  const rows = (custResult.data || []).map((c) => {
    const ar = byCustomer.get(c.name) || { total: {}, count: 0 };
    return {
      erpnext_name: c.name,
      customer_name: c.customer_name,
      mobile_no: c.mobile_no,
      email: c.email_id,
      default_currency: c.default_currency,
      customer_group: c.customer_group,
      outstanding_by_currency: ar.total,
      open_invoice_count: ar.count,
      linked_user_id: linkedByErpName.get(c.name) || null,
    };
  });

  rows.sort((a, b) => {
    const aSum = Object.values(a.outstanding_by_currency).reduce((s, v) => s + Math.abs(v), 0);
    const bSum = Object.values(b.outstanding_by_currency).reduce((s, v) => s + Math.abs(v), 0);
    if (aSum !== bSum) return bSum - aSum;
    return (a.customer_name || '').localeCompare(b.customer_name || '');
  });

  return rows;
}

module.exports = { listCustomersWithAR };
