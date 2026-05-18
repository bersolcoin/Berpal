/**
 * Find (or auto-create) a per-currency wallet leaf for the user.
 *
 * Symmetric to party-account.js for Receivable/Payable — same shape, but
 * for Cash / Bank / Credit-Card account types.
 *
 *   parentCode: '1000' (→ Cash) | '1100' (→ Bank) | '2100' (→ Credit Card).
 *               Anything else falls back to 'Cash'.
 *   currency:   ISO code matching the desired wallet currency.
 *   walletName: REQUIRED for Bank/Card so the leaf has a meaningful name
 *               (e.g. "BBL Savings", "AmEx Platinum"). OPTIONAL for Cash —
 *               the leaf becomes "Cash (<CCY>)" if omitted.
 *
 * Naming convention:
 *   With name:    "<wallet_name> <Type> (<CCY>)"   "HSBC HK Bank (USD)"
 *   Without name: "<Type> (<CCY>)"                  "Cash (USD)"
 *   Avoids doubling if name already includes type word ("BBL Bank" → "BBL Bank (USD)").
 *
 * Cache key includes walletName so two banks in the same currency cache separately.
 *
 * Errors:
 *   NEED_WALLET_NAME    Bank/Card requested without a walletName
 *   AMBIGUOUS_WALLET    Multiple existing leaves match — caller asks user to disambiguate
 */

const { ts } = require('../log');

const _cache = new Map();

function accountTypeForCode(parentCode) {
  return parentCode === '1100'
    ? 'Bank'
    : parentCode === '2100'
      ? 'Credit Card'
      : 'Cash';
}

function buildLeafName(accountType, currency, walletName) {
  const typeWord = accountType === 'Credit Card' ? 'Card' : accountType;
  let base;
  if (!walletName) {
    base = typeWord;
  } else if (/\b(bank|card|cash)\b/i.test(walletName)) {
    base = walletName.trim();
  } else {
    base = `${walletName.trim()} ${typeWord}`;
  }
  return `${base} (${currency})`;
}

async function resolveWalletAccount(erp, parentCode, currency, walletName = null) {
  const accountType = accountTypeForCode(parentCode);

  if ((accountType === 'Bank' || accountType === 'Credit Card') && !walletName) {
    const err = new Error(
      `${accountType} wallet requires a name (e.g. "BBL", "SCB", "AmEx"). Got payment_account_code=${parentCode} but no wallet_name.`
    );
    err.code = 'NEED_WALLET_NAME';
    throw err;
  }

  const leafName = buildLeafName(accountType, currency, walletName);
  const cacheKey = `${erp.company}|${accountType}|${currency}|${(walletName || '').toLowerCase()}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  // 1. Exact name match (new format).
  const exact = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['account_type', '=', accountType],
      ['account_currency', '=', currency],
      ['is_group', '=', 0],
      ['account_name', '=', leafName],
    ],
    fields: ['name'],
    limit: 1,
  });
  if (exact.data && exact.data.length > 0) {
    _cache.set(cacheKey, exact.data[0].name);
    return exact.data[0].name;
  }

  // 2. Fuzzy: same type+currency, name containing walletName. Throws if
  //    multiple matches (caller asks user to pick).
  if (walletName) {
    const fuzzy = await erp.listResource('Account', {
      filters: [
        ['company', '=', erp.company],
        ['account_type', '=', accountType],
        ['account_currency', '=', currency],
        ['is_group', '=', 0],
        ['account_name', 'like', `%${walletName}%`],
      ],
      fields: ['name', 'account_name'],
      limit: 10,
    });
    if (fuzzy.data && fuzzy.data.length === 1) {
      _cache.set(cacheKey, fuzzy.data[0].name);
      return fuzzy.data[0].name;
    }
    if (fuzzy.data && fuzzy.data.length > 1) {
      const candidates = fuzzy.data.map((r) => r.account_name);
      const err = new Error(
        `Multiple ${accountType.toLowerCase()} accounts match "${walletName}" in ${currency}: ${candidates.join(', ')}. Ask the user which one and resave with wallet_name set to the full match name.`
      );
      err.code = 'AMBIGUOUS_WALLET';
      err.candidates = fuzzy.data.map((r) => ({
        erpnext_name: r.name,
        account_name: r.account_name,
      }));
      throw err;
    }
  } else {
    // No walletName + Cash: any cash leaf in this currency is acceptable.
    const anyCash = await erp.listResource('Account', {
      filters: [
        ['company', '=', erp.company],
        ['account_type', '=', accountType],
        ['account_currency', '=', currency],
        ['is_group', '=', 0],
      ],
      fields: ['name'],
      limit: 1,
    });
    if (anyCash.data && anyCash.data.length > 0) {
      _cache.set(cacheKey, anyCash.data[0].name);
      return anyCash.data[0].name;
    }
  }

  // 3. Create the leaf. Locate parent group first.
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

  const result = await erp.createAccount({
    account_name: leafName,
    parent_account: parentAccount,
    account_type: accountType,
    account_currency: currency,
  });
  const erpName = result.data?.name;
  console.log(
    `• [conversation] [${ts()}] created ${accountType} account in ERPNext: ${erpName} (currency=${currency})`
  );
  _cache.set(cacheKey, erpName);
  return erpName;
}

module.exports = { resolveWalletAccount, accountTypeForCode, buildLeafName };
