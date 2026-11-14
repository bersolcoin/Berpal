/**
 * List expense accounts (root_type=Expense, leaf-only) with current balance
 * — i.e. total spent since opening for the user's fiscal period. Used by
 * the /expenses page to show where money is going.
 *
 * Returns:
 *   {
 *     accounts: [
 *       { erpnext_name, account_number, account_name, currency, balance }, ...
 *     ],
 *     totals_by_currency: { USD: 1500, THB: 5000 },
 *     as_of: 'YYYY-MM-DD'
 *   }
 *
 * Balance is the debit-side total — positive numbers represent spending.
 * Currency is the account's currency; for multi-currency expense accounts
 * (rare), each currency bucket sums separately.
 */

async function getExpenseSummary(user, erp, { asOf = null } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10);

  // Pull all leaf Expense accounts, then filter out Cost of Goods Sold in
  // JS — COGS is technically a cost of sales (above the gross-profit line),
  // not an operating expense. It still has its own ledger reachable via
  // /accounts. We also catch accounts whose parent_account name contains
  // "Cost of Goods" so custom charts that nest COGS under a group are
  // handled too.
  const r = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['root_type', '=', 'Expense'],
      ['is_group', '=', 0],
    ],
    fields: ['name', 'account_name', 'account_number', 'account_type', 'account_currency', 'parent_account'],
    limit: 200,
    orderBy: 'account_number asc',
  });

  const operatingLeaves = (r.data || []).filter(
    (a) =>
      a.account_type !== 'Cost of Goods Sold' &&
      !/cost of goods sold/i.test(a.parent_account || '')
  );

  const accounts = [];
  const totalsByCurrency = {};

  await Promise.all(
    operatingLeaves.map(async (a) => {
      let balance = 0;
      try {
        balance = await erp.getAccountBalance(a.name, date);
      } catch (err) {
        console.warn(`[expense-summary] balance lookup failed for ${a.name}: ${err.message}`);
      }
      accounts.push({
        erpnext_name: a.name,
        account_number: a.account_number,
        account_name: a.account_name,
        currency: a.account_currency,
        balance,
      });
      const ccy = a.account_currency || 'UNKNOWN';
      totalsByCurrency[ccy] = (totalsByCurrency[ccy] || 0) + balance;
    })
  );

  // Sort: biggest spend first, then by account_number for stable ordering.
  accounts.sort((a, b) => {
    if (Math.abs(b.balance) !== Math.abs(a.balance)) return Math.abs(b.balance) - Math.abs(a.balance);
    return (a.account_number || '').localeCompare(b.account_number || '');
  });

  return { accounts, totals_by_currency: totalsByCurrency, as_of: date };
}

module.exports = { getExpenseSummary };
