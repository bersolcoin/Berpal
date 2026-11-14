/**
 * Resolve (or auto-create) a Receivable / Payable account in the given currency.
 *
 * ERPNext rejects an invoice where the document currency doesn't match the
 * party account currency. For a multi-currency setup we need one Debtors /
 * Creditors leaf account per currency. The standard pattern:
 *
 *   Accounts Receivable (group)
 *     ├── Debtors          (THB, leaf)        <- company default
 *     ├── Debtors USD      (USD, leaf)        <- auto-created on first USD invoice
 *     └── Debtors EUR      (EUR, leaf)        <- etc.
 *
 *   accountType: 'Receivable' | 'Payable'
 *   currency:    'USD' | 'THB' | …
 *   returns:     ERPNext account name (e.g. "Debtors USD - TTC")
 *
 * Per-process memo so repeated calls in the same run are cheap.
 */

const { ts } = require('../log');
const { getNextAccountNumber } = require('./account-numbering');
const { upsertAccountInCoaCache } = require('./coa-cache');

const _cache = new Map();

/** Company.default_receivable_account / default_payable_account (memoized). */
const _defaults = new Map();
async function getCompanyDefaultPartyAccount(erp, accountType) {
  const key = `${erp.company}|${accountType}`;
  if (!_defaults.has(key)) {
    const field = accountType === 'Receivable' ? 'default_receivable_account' : 'default_payable_account';
    try {
      const r = await erp.getResource('Company', erp.company);
      _defaults.set(key, r.data?.[field] || null);
    } catch {
      _defaults.set(key, null);
    }
  }
  return _defaults.get(key);
}

async function resolvePartyAccount(erp, accountType, currency, user = null) {
  const cacheKey = `${erp.company}|${accountType}|${currency}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  // 1. Existing leaf account in this currency? A chart can hold several
  //    leaves of this type (v16 flags "Employee Advances" as Payable too),
  //    so prefer the Company's default party account, then a Debtors /
  //    Creditors name — never just whichever row ERPNext returns first.
  const existing = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['account_type', '=', accountType],
      ['account_currency', '=', currency],
      ['is_group', '=', 0],
    ],
    fields: ['name', 'account_name'],
    limit: 50,
  });
  const leaves = existing.data || [];
  if (leaves.length > 0) {
    const companyDefault = await getCompanyDefaultPartyAccount(erp, accountType);
    const baseWord = accountType === 'Receivable' ? 'debtors' : 'creditors';
    const pick =
      leaves.find((a) => a.name === companyDefault) ||
      leaves.find((a) => (a.account_name || '').toLowerCase().includes(baseWord)) ||
      leaves[0];
    _cache.set(cacheKey, pick.name);
    return pick.name;
  }

  // 2. Locate the parent group ("Accounts Receivable" / "Accounts Payable").
  //    Prefer the is_group=1 account with this account_type. Fall back to
  //    walking up from any existing leaf with the same type.
  let parentAccount = null;
  const groups = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['account_type', '=', accountType],
      ['is_group', '=', 1],
    ],
    fields: ['name'],
    limit: 1,
  });
  if (groups.data && groups.data.length > 0) {
    parentAccount = groups.data[0].name;
  } else {
    const anyLeaf = await erp.listResource('Account', {
      filters: [
        ['company', '=', erp.company],
        ['account_type', '=', accountType],
        ['is_group', '=', 0],
      ],
      fields: ['parent_account'],
      limit: 1,
    });
    parentAccount = anyLeaf.data?.[0]?.parent_account || null;
  }
  if (!parentAccount) {
    throw new Error(
      `[erpnext] could not locate parent ${accountType} group account for company ${erp.company}`
    );
  }

  // 3. Create the per-currency leaf.
  const baseName = accountType === 'Receivable' ? 'Debtors' : 'Creditors';
  const accountName = `${baseName} ${currency}`;
  const accountNumber = await getNextAccountNumber(erp, parentAccount);
  const result = await erp.createAccount({
    account_name: accountName,
    parent_account: parentAccount,
    account_type: accountType,
    account_currency: currency,
    ...(accountNumber ? { account_number: accountNumber } : {}),
  });
  const erpName = result.data?.name;
  console.log(
    `• [conversation] [${ts()}] created ${accountType} account in ERPNext: ${erpName} (currency=${currency})`
  );
  _cache.set(cacheKey, erpName);

  if (user?.id) {
    try {
      await upsertAccountInCoaCache(user.id, {
        name: erpName,
        account_name: accountName,
        account_number: accountNumber || null,
        account_type: accountType,
        root_type: accountType === 'Receivable' ? 'Asset' : 'Liability',
        account_currency: currency,
        is_group: 0,
        parent_account: parentAccount,
      });
    } catch (err) {
      console.warn(`• [coa-cache] [${ts()}] append failed for ${erpName}: ${err.message}`);
    }
  }

  return erpName;
}

module.exports = { resolvePartyAccount };
