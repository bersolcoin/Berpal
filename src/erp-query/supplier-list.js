/**
 * List all suppliers with open AP balance per currency. Mirror of
 * customer-list.js but for the buy side (Purchase Invoice).
 */

const { query } = require('../db');

async function listSuppliersWithAP(user, erp, { limit = 200 } = {}) {
  const [supResult, billResult, linksResult] = await Promise.all([
    erp.listResource('Supplier', {
      fields: ['name', 'supplier_name', 'mobile_no', 'email_id', 'default_currency', 'supplier_group'],
      limit,
      orderBy: 'supplier_name asc',
    }),
    erp.listResource('Purchase Invoice', {
      filters: [
        ['company', '=', erp.company],
        ['docstatus', '=', 1],
        ['outstanding_amount', '>', 0],
      ],
      fields: ['supplier', 'currency', 'outstanding_amount'],
      limit: 500,
    }),
    query(
      `SELECT erpnext_name, linked_user_id FROM counterparty_cache
         WHERE owner_user_id = $1 AND erpnext_doctype = 'Supplier'
           AND linked_user_id IS NOT NULL`,
      [user.id]
    ),
  ]);

  const linkedByErpName = new Map();
  for (const row of linksResult.rows || []) {
    linkedByErpName.set(row.erpnext_name, row.linked_user_id);
  }

  const bySupplier = new Map();
  for (const bill of billResult.data || []) {
    if (!bySupplier.has(bill.supplier)) {
      bySupplier.set(bill.supplier, { total: {}, count: 0 });
    }
    const slot = bySupplier.get(bill.supplier);
    slot.total[bill.currency] = (slot.total[bill.currency] || 0) + (bill.outstanding_amount || 0);
    slot.count += 1;
  }

  const rows = (supResult.data || []).map((s) => {
    const ap = bySupplier.get(s.name) || { total: {}, count: 0 };
    return {
      erpnext_name: s.name,
      supplier_name: s.supplier_name,
      mobile_no: s.mobile_no,
      email: s.email_id,
      default_currency: s.default_currency,
      supplier_group: s.supplier_group,
      outstanding_by_currency: ap.total,
      open_bill_count: ap.count,
      linked_user_id: linkedByErpName.get(s.name) || null,
    };
  });

  rows.sort((a, b) => {
    const aSum = Object.values(a.outstanding_by_currency).reduce((s, v) => s + Math.abs(v), 0);
    const bSum = Object.values(b.outstanding_by_currency).reduce((s, v) => s + Math.abs(v), 0);
    if (aSum !== bSum) return bSum - aSum;
    return (a.supplier_name || '').localeCompare(b.supplier_name || '');
  });

  return rows;
}

module.exports = { listSuppliersWithAP };
