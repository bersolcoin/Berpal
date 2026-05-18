/**
 * Full chart of accounts for the user's Company, grouped by root_type
 * (Asset, Liability, Equity, Income, Expense).
 *
 * Returns:
 *   {
 *     groups: {
 *       Asset:     [accounts...],
 *       Liability: [accounts...],
 *       ...
 *     }
 *     all: [...]
 *   }
 *
 * Group accounts (`is_group=1`) are included so the UI can render the
 * hierarchy if it wants — leaves are the ones that hold balances.
 */

const ROOT_TYPE_ORDER = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];

async function listAccounts(user, erp, { limit = 500 } = {}) {
  const r = await erp.listResource('Account', {
    filters: [['company', '=', erp.company]],
    fields: [
      'name',
      'account_name',
      'account_number',
      'account_type',
      'account_currency',
      'root_type',
      'is_group',
      'parent_account',
      'lft',
    ],
    limit,
    orderBy: 'lft asc',
  });

  const all = (r.data || []).map((a) => ({
    erpnext_name: a.name,
    account_name: a.account_name,
    account_number: a.account_number,
    account_type: a.account_type,
    root_type: a.root_type,
    currency: a.account_currency,
    is_group: !!a.is_group,
    parent_account: a.parent_account,
  }));

  const groups = {};
  for (const rt of ROOT_TYPE_ORDER) groups[rt] = [];
  for (const a of all) {
    const k = a.root_type || 'Other';
    if (!groups[k]) groups[k] = [];
    groups[k].push(a);
  }

  return { groups, all };
}

module.exports = { listAccounts };
