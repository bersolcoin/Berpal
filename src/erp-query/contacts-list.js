/**
 * Unified Contacts list — merges Customers (AR side) and Suppliers (AP side)
 * by name (case-insensitive). Each contact gets AR + AP + net balance per
 * currency.
 *
 *   balance = AR − AP   (positive = net receivable from them)
 *
 * If a contact name exists on both sides we treat it as one logical contact.
 * If names diverge slightly ("Acme Trading" customer vs "Acme Trading Co"
 * supplier) we currently surface them as two contacts — phone-based fuzzy
 * matching can come later.
 */

const { query } = require('../db');
const { listCustomersWithAR } = require('./customer-list');
const { listSuppliersWithAP } = require('./supplier-list');

function normName(s) {
  return String(s || '').trim().toLowerCase();
}

function normPhone(s) {
  if (!s) return null;
  const digits = String(s).replace(/[^\d+]/g, '');
  if (!digits) return null;
  // Match exact, or with a stripped leading +. Picks a canonical form
  // (+-prefixed when present) so two entries with the same actual number
  // collapse to one bucket regardless of formatting.
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/**
 * Merge key: phone (when available) is the primary identifier — most
 * reliable, eliminates name-variation false splits. Falls back to a
 * normalized name when the contact has no phone yet.
 */
function mergeKey(name, phone) {
  const p = normPhone(phone);
  return p ? `p:${p}` : `n:${normName(name)}`;
}

async function listContacts(user, erp, { limit = 200, q = '' } = {}) {
  const [customers, suppliers, linksResult] = await Promise.all([
    listCustomersWithAR(user, erp, { limit }).catch(() => []),
    listSuppliersWithAP(user, erp, { limit }).catch(() => []),
    query(
      `SELECT erpnext_name, linked_user_id FROM counterparty_cache
         WHERE owner_user_id = $1 AND linked_user_id IS NOT NULL`,
      [user.id]
    ).catch(() => ({ rows: [] })),
  ]);

  const linkedByErpName = new Map();
  for (const row of linksResult.rows || []) {
    linkedByErpName.set(row.erpnext_name, row.linked_user_id);
  }

  // Index by normalized name so we can merge sides.
  const byKey = new Map();

  for (const c of customers) {
    const key = mergeKey(c.customer_name, c.mobile_no);
    byKey.set(key, {
      key,
      display_name: c.customer_name,
      phone: c.mobile_no || null,
      email: c.email || null,
      default_currency: c.default_currency || null,
      group: c.customer_group || null,
      customer_erpnext_name: c.erpnext_name,
      supplier_erpnext_name: null,
      ar_by_currency: { ...c.outstanding_by_currency },
      ap_by_currency: {},
      open_invoice_count: c.open_invoice_count,
      open_bill_count: 0,
      linked_user_id: c.linked_user_id || linkedByErpName.get(c.erpnext_name) || null,
    });
  }

  for (const s of suppliers) {
    const key = mergeKey(s.supplier_name, s.mobile_no);
    const existing = byKey.get(key);
    if (existing) {
      existing.supplier_erpnext_name = s.erpnext_name;
      existing.ap_by_currency = { ...s.outstanding_by_currency };
      existing.open_bill_count = s.open_bill_count;
      existing.phone = existing.phone || s.mobile_no || null;
      existing.email = existing.email || s.email || null;
      existing.default_currency = existing.default_currency || s.default_currency || null;
      existing.linked_user_id =
        existing.linked_user_id || s.linked_user_id || linkedByErpName.get(s.erpnext_name) || null;
    } else {
      byKey.set(key, {
        key,
        display_name: s.supplier_name,
        phone: s.mobile_no || null,
        email: s.email || null,
        default_currency: s.default_currency || null,
        group: s.supplier_group || null,
        customer_erpnext_name: null,
        supplier_erpnext_name: s.erpnext_name,
        ar_by_currency: {},
        ap_by_currency: { ...s.outstanding_by_currency },
        open_invoice_count: 0,
        open_bill_count: s.open_bill_count,
        linked_user_id: s.linked_user_id || linkedByErpName.get(s.erpnext_name) || null,
      });
    }
  }

  // Net balance per currency (AR − AP) and absolute total for sorting.
  const rows = [...byKey.values()].map((c) => {
    const allCcys = new Set([
      ...Object.keys(c.ar_by_currency),
      ...Object.keys(c.ap_by_currency),
    ]);
    const balance_by_currency = {};
    for (const ccy of allCcys) {
      const net = (c.ar_by_currency[ccy] || 0) - (c.ap_by_currency[ccy] || 0);
      if (Math.abs(net) > 0.005) balance_by_currency[ccy] = net;
    }
    return { ...c, balance_by_currency };
  });

  // Free-text filter on name / phone / email.
  let filtered = rows;
  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    filtered = filtered.filter(
      (c) =>
        (c.display_name || '').toLowerCase().includes(needle) ||
        (c.phone || '').toLowerCase().includes(needle) ||
        (c.email || '').toLowerCase().includes(needle)
    );
  }

  // Sort: contacts with non-zero balance first (absolute size), then alpha.
  filtered.sort((a, b) => {
    const aSum = Object.values(a.balance_by_currency).reduce((s, v) => s + Math.abs(v), 0);
    const bSum = Object.values(b.balance_by_currency).reduce((s, v) => s + Math.abs(v), 0);
    if (aSum !== bSum) return bSum - aSum;
    return a.display_name.localeCompare(b.display_name);
  });

  return filtered;
}

module.exports = { listContacts };
