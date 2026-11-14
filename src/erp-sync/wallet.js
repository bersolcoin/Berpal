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
const { getNextAccountNumber } = require('./account-numbering');
const { filterAccounts, upsertAccountInCoaCache } = require('./coa-cache');

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
  // Names like "Cash (USD)" (onboarding's auto-named cash wallets) already
  // carry the currency — strip it so we don't produce "Cash (USD) (USD)".
  if (walletName) {
    walletName = walletName.replace(new RegExp(`\\s*\\(${currency}\\)\\s*$`, 'i'), '') || null;
  }
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

async function resolveWalletAccount(erp, parentCode, currency, walletName = null, user = null, opts = {}) {
  const accountType = accountTypeForCode(parentCode);
  const { dryRun = false } = opts;

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

  // Cache-first lookup: read from coa_cache in PG instead of round-
  // tripping to ERPNext. Falls back to live API for users without a
  // seeded cache (legacy tenants pre-coa-cache).
  if (user?.id) {
    const candidates = await filterAccounts(user.id, {
      account_type: accountType,
      account_currency: currency,
      is_group: false,
    });
    // Exact name match wins
    const exact = candidates.find((a) => a.account_name === leafName);
    if (exact) {
      _cache.set(cacheKey, exact.name);
      return exact.name;
    }
    // Fuzzy by walletName — tokenize so "Cash HKD" matches
    // "cash (HKD)" (parens would break a raw includes()).
    if (walletName) {
      const tokens = walletName.toLowerCase().split(/\s+/).filter(Boolean);
      const fuzzy = candidates.filter((a) => {
        const lower = (a.account_name || '').toLowerCase();
        return tokens.every((t) => lower.includes(t));
      });
      if (fuzzy.length === 1) {
        _cache.set(cacheKey, fuzzy[0].name);
        return fuzzy[0].name;
      }
      if (fuzzy.length > 1) {
        const names = fuzzy.map((a) => a.account_name);
        const err = new Error(
          `Multiple ${accountType.toLowerCase()} accounts match "${walletName}" in ${currency}: ${names.join(', ')}. Ask the user which one and resave with wallet_name set to the full match name.`
        );
        err.code = 'AMBIGUOUS_WALLET';
        err.candidates = fuzzy.map((a) => ({ erpnext_name: a.name, account_name: a.account_name }));
        throw err;
      }
    } else if (candidates.length > 0) {
      // No walletName + cash: any leaf in this currency is fine.
      _cache.set(cacheKey, candidates[0].name);
      return candidates[0].name;
    }
    // Cache miss for this combo — fall through to create.
  } else {
    // No user (e.g. during provisionTenant before users.id exists). Use
    // the live ERPNext path as before.
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
          `Multiple ${accountType.toLowerCase()} accounts match "${walletName}" in ${currency}: ${candidates.join(', ')}.`
        );
        err.code = 'AMBIGUOUS_WALLET';
        err.candidates = fuzzy.data.map((r) => ({ erpnext_name: r.name, account_name: r.account_name }));
        throw err;
      }
    } else {
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
  }

  // dryRun preview (used by request_confirmation): cache had no match,
  // so the real save would create a new leaf. Don't create — just
  // return what the leaf WOULD be named (e.g. "Cash (HKD)") so the
  // confirmation card shows accurate text. The next save_transaction
  // runs the real path and creates the account.
  if (dryRun) {
    return leafName;
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

  // Derive next number under the parent (1100 → 1110, 1120, …) so the
  // bot-created leaves match the "Standard with Numbers" convention.
  // Returns null on unnumbered charts — then we just skip the field.
  const accountNumber = await getNextAccountNumber(erp, parentAccount);

  const result = await erp.createAccount({
    account_name: leafName,
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

  // Mirror into PG coa_cache so subsequent resolves (this request OR
  // future ones) find it without round-tripping. Fire-and-forget;
  // refresh-cache script can repair if we miss.
  if (user?.id) {
    try {
      await upsertAccountInCoaCache(user.id, {
        name: erpName,
        account_name: leafName,
        account_number: accountNumber || null,
        account_type: accountType,
        root_type: 'Asset',
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

module.exports = { resolveWalletAccount, accountTypeForCode, buildLeafName };
