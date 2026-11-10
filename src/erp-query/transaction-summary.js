/**
 * READ side — income / expense totals over a period, from GL Entries on P&L accounts.
 * Amounts are in the company (reporting) currency, since that's what P&L accounts hold.
 */
const counterparties = require('../counterparties');
const { round2, friendlyAccountName, companyCurrency } = require('../erp-sync/common');

const ROOT_TYPE = { income: 'Income', expense: 'Expense' };

/**
 *   direction: 'income' | 'expense'
 *   date_from / date_to: ISO dates (default: Jan 1 this year → today)
 *   group_by: 'none' | 'category' | 'month'
 *   counterparty_id: optional — matches GL lines whose `against` is that party (invoices/bills)
 */
async function getTransactionSummary(user, erp, {
  direction = 'expense', date_from = null, date_to = null, group_by = 'none', counterparty_id = null,
} = {}) {
  const rootType = ROOT_TYPE[direction];
  if (!rootType) return { ok: false, error: "direction must be 'income' or 'expense'" };
  const today = new Date().toISOString().slice(0, 10);
  const from = date_from || `${today.slice(0, 4)}-01-01`;
  const to = date_to || today;

  const accounts = await erp.listAccounts({
    filters: [['company', '=', erp.company], ['root_type', '=', rootType], ['is_group', '=', 0]],
    fields: ['name', 'account_name'],
    limit: 500,
  });
  const accountNames = (accounts.data || []).map((a) => a.name);
  if (accountNames.length === 0) return { ok: true, total: 0, count: 0, groups: [] };

  const filters = [
    ['company', '=', erp.company],
    ['account', 'in', accountNames],
    ['posting_date', 'between', [from, to]],
    ['is_cancelled', '=', 0],
  ];
  if (counterparty_id) {
    const contact = await counterparties.getById(user, counterparty_id);
    if (!contact) return { ok: false, error: `counterparty_id ${counterparty_id} not found` };
    const party = direction === 'income' ? contact.erpnext_customer : contact.erpnext_supplier;
    if (!party) return { ok: true, currency: companyCurrency(user), total: 0, count: 0, groups: [] };
    filters.push(['against', 'like', `%${party}%`]);
  }

  const gl = await erp.listResource('GL Entry', {
    filters,
    fields: ['account', 'posting_date', 'debit', 'credit', 'voucher_no'],
    limit: 10000,
  });

  const sign = direction === 'income' ? -1 : 1; // expense = Dr − Cr, income = Cr − Dr
  const groups = new Map();
  const vouchers = new Set();
  let total = 0;
  for (const g of gl.data || []) {
    const amt = sign * ((g.debit || 0) - (g.credit || 0));
    total += amt;
    vouchers.add(g.voucher_no);
    if (group_by === 'none') continue;
    const key = group_by === 'month' ? String(g.posting_date).slice(0, 7) : friendlyAccountName(g.account);
    const grp = groups.get(key) || { key, total: 0, vouchers: new Set() };
    grp.total += amt;
    grp.vouchers.add(g.voucher_no);
    groups.set(key, grp);
  }

  const out = [...groups.values()]
    .map((g) => ({ key: g.key, total: round2(g.total), count: g.vouchers.size }))
    .filter((g) => Math.abs(g.total) >= 0.005);
  out.sort(group_by === 'month' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.total - a.total);

  return {
    ok: true,
    currency: companyCurrency(user),
    date_from: from,
    date_to: to,
    total: round2(total),
    count: vouchers.size,
    groups: out,
  };
}

module.exports = { getTransactionSummary };
