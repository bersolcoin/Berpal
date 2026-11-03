/**
 * READ side — unpaid Sales Invoices (receivables) and Purchase Invoices (payables), live from ERPNext.
 * Totals cover the full filtered set even when rows are truncated to `limit`.
 */
const counterparties = require('../counterparties');
const { round2 } = require('../erp-sync/common');

const SIDES = {
  receivable: {
    doctype: 'Sales Invoice', party: 'customer', partyName: 'customer_name', role: 'erpnext_customer',
  },
  payable: {
    doctype: 'Purchase Invoice', party: 'supplier', partyName: 'supplier_name', role: 'erpnext_supplier',
  },
};
const FETCH_CAP = 500;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000);
}

const SORTS = {
  due_date_asc: (a, b) => (a.due_date || '').localeCompare(b.due_date || '') || a.ref.localeCompare(b.ref),
  amount_desc: (a, b) => b.base_outstanding - a.base_outstanding,
  newest: (a, b) => (b.date || '').localeCompare(a.date || '') || b.ref.localeCompare(a.ref),
};

async function fetchSide(erp, side, { partyName, search, dueOnOrBefore, today }) {
  const s = SIDES[side];
  const filters = [
    ['company', '=', erp.company],
    ['docstatus', '=', 1],
    ['outstanding_amount', '>', 0],
  ];
  if (partyName) filters.push([s.party, '=', partyName]);
  if (search) filters.push([s.partyName, 'like', `%${search}%`]);
  if (dueOnOrBefore) filters.push(['due_date', '<=', dueOnOrBefore]);

  const r = await erp.listResource(s.doctype, {
    filters,
    fields: ['name', s.party, s.partyName, 'posting_date', 'due_date', 'currency',
      'grand_total', 'outstanding_amount', 'conversion_rate'],
    limit: FETCH_CAP,
    orderBy: 'due_date asc',
  });
  return (r.data || []).map((d) => {
    const daysUntilDue = d.due_date ? daysBetween(today, d.due_date) : null;
    return {
      ref: d.name,
      doctype: s.doctype,
      kind: side,
      counterparty: d[s.partyName] || d[s.party],
      date: d.posting_date,
      due_date: d.due_date,
      currency: d.currency,
      amount: d.grand_total,
      outstanding: d.outstanding_amount,
      exchange_rate: d.conversion_rate || 1,
      base_outstanding: round2(d.outstanding_amount * (d.conversion_rate || 1)),
      days_until_due: daysUntilDue,
      overdue_days: daysUntilDue != null && daysUntilDue < 0 ? -daysUntilDue : 0,
    };
  });
}

/**
 *   direction:          'receivable' | 'payable' | 'both'
 *   counterparty_id:    cache id (preferred — exact party)
 *   counterparty_search: name fragment (only when unambiguous)
 *   due_within_days:    only items due on/before today + N (overdue included)
 *   today:              ISO date to count days from (default: server UTC date). Pass the user's
 *                       local date when it matters, e.g. the morning digest in UTC+9.
 *   sort:               'due_date_asc' | 'amount_desc' | 'newest'
 */
async function getOpenInvoices(user, erp, {
  direction = 'both', counterparty_id = null, counterparty_search = null,
  due_within_days = null, sort = 'due_date_asc', limit = 5, today = null,
} = {}) {
  const asOf = today || todayStr();
  const sides = direction === 'both' ? ['receivable', 'payable'] : [direction];
  let contact = null;
  if (counterparty_id) {
    contact = await counterparties.getById(user, counterparty_id);
    if (!contact) return { ok: false, error: `counterparty_id ${counterparty_id} not found` };
  }
  const dueOnOrBefore = due_within_days != null ? addDays(asOf, Number(due_within_days)) : null;

  let rows = [];
  for (const side of sides) {
    let partyName = null;
    if (contact) {
      partyName = contact[SIDES[side].role];
      if (!partyName) continue; // this contact has never been a customer/supplier
    }
    rows.push(...(await fetchSide(erp, side, { partyName, search: contact ? null : counterparty_search, dueOnOrBefore, today: asOf })));
  }

  rows.sort(SORTS[sort] || SORTS.due_date_asc);
  const totals = {};
  for (const r of rows) {
    const t = (totals[r.kind] ||= {});
    t[r.currency] = round2((t[r.currency] || 0) + r.outstanding);
  }
  const n = Math.max(1, Math.min(Number(limit) || 5, 50));
  return {
    ok: true,
    total_count: rows.length,
    totals_by_currency: totals,
    limit: n,
    rows: rows.slice(0, n),
    ...(contact ? { counterparty: contact.name } : {}),
  };
}

module.exports = { getOpenInvoices, addDays, todayStr };
