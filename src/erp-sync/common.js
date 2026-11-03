/**
 * Shared helpers for the ERPNext write side: account resolution, party accounts,
 * generic line items, journal titles, due dates.
 */
const { query } = require('../db');

// Maps OUR internal category code → ERPNext account code prefix.
// ERPNext's "Standard with Numbers" template uses different codes than our pre-pivot chart,
// so we map across. Look-up at save time appends company abbreviation dynamically.
const ERP_CODE_MAP = {
  // Income
  '4000': '4110', // Sales Revenue → Sales
  '4100': '4120', // Service Revenue → Service
  '4900': '4210', // Other Income → Interest Income (closest)
  // COGS
  '5000': '5111', // Cost of Goods Sold
  // Expenses
  '5100': '5204', // Meals & Entertainment → Entertainment Expenses
  '5200': '5216', // Travel
  '5210': '5216', // Vehicle → Travel (no specific)
  '5300': '5211', // Office Supplies → Print and Stationery
  '5350': '5223', // Insurance → Misc
  '5400': '5209', // Rent → Office Rent
  '5500': '5217', // Utilities
  '5550': '5215', // Telephone & Internet
  '5600': '5223', // Software → Misc
  '5700': '5206', // Professional Services → Legal
  '5800': '5207', // Marketing
  '5900': '5223', // Other Expenses → Misc
  '5950': '5221', // Bank Charges
  // Wallets / assets
  '1000': '1110', // Cash → Cash
  // 1100 Bank / 2100 Credit Card have no generic account — they resolve through a wallet (src/wallets.js)
  '1200': '1310', // Accounts Receivable → Debtors
  // Liabilities
  '2000': '2110', // Accounts Payable → Creditors
  // Equity
  '3000': '3100', // Owner's Equity → Capital Stock
  '3100': '3400', // Retained Earnings
  '3200': '3300', // Opening Balance Equity
};

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** The ERPNext Company's base currency. One Company per user, so this is the user's reporting currency. */
function companyCurrency(user) {
  return user.reporting_currency || 'THB';
}

/**
 * Resolve an ERPNext account name from our internal category code, scoped to the user's company + currency.
 *
 * Cache strategy: Postgres `account_cache` table (persists across restarts, shared across instances).
 *  1. Look up cache row (user_id, name=ourCode, currency).
 *  2. Hit → return ERPNext name immediately. No API call.
 *  3. Miss → query ERPNext for the right account, then INSERT into cache.
 *
 * Manual refresh: just DELETE rows from account_cache for the user (or change the UI later
 * to expose a "resync chart" action).
 */
async function resolveErpAccount(user, erp, ourCode, currency = null) {
  const cur = currency || companyCurrency(user);

  const cached = await query(
    `SELECT erpnext_account_name FROM account_cache
     WHERE user_id = $1 AND name = $2 AND currency = $3 AND is_active = 1
     LIMIT 1`,
    [user.id, ourCode, cur]
  );
  if (cached.rowCount > 0 && cached.rows[0].erpnext_account_name) {
    return cached.rows[0].erpnext_account_name;
  }

  const erpCodePrefix = ERP_CODE_MAP[ourCode];
  if (!erpCodePrefix) return null;

  const r = await erp.listAccounts({
    filters: [
      ['name', 'like', `${erpCodePrefix} - %`],
      ['company', '=', erp.company],
      ['is_group', '=', 0],
    ],
    limit: 1,
  });
  const erpName = r.data?.[0]?.name || null;
  if (!erpName) return null;

  const now = new Date().toISOString();
  await query(
    `INSERT INTO account_cache
       (user_id, name, account_type, currency, erpnext_account_name, is_active, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4, 1, $5, $5)
     ON CONFLICT (user_id, name, currency) DO UPDATE SET
       erpnext_account_name = EXCLUDED.erpnext_account_name,
       updated_at = EXCLUDED.updated_at`,
    [user.id, ourCode, cur, erpName, now]
  );

  console.log(`• [erp-sync] [${ts()}] account_cache miss → wrote ${ourCode}/${cur} = "${erpName}"`);
  return erpName;
}

/**
 * Currency an ERPNext Account is held in. Per-process memo — an account's currency
 * can't change once it has GL entries.
 */
const _accountCurrencyCache = new Map();
async function getAccountCurrency(erp, accountName) {
  const key = `${erp.company}|${accountName}`;
  if (_accountCurrencyCache.has(key)) return _accountCurrencyCache.get(key);
  const r = await erp.getResource('Account', accountName);
  const cur = r.data?.account_currency || null;
  _accountCurrencyCache.set(key, cur);
  return cur;
}

/**
 * Strip the "<code> - " prefix and " - <abbr>" suffix from an ERPNext account
 * name, leaving just the human-readable middle.
 *   "1000 - Cash - TTC"                      → "Cash"
 *   "5223 - Miscellaneous Expenses - TTC"    → "Miscellaneous Expenses"
 *   "BBL Savings - TTC"                      → "BBL Savings"      (no code prefix)
 *   "Cash"                                   → "Cash"             (already friendly)
 */
function friendlyAccountName(erpAccountName) {
  if (!erpAccountName) return '';
  return String(erpAccountName)
    .replace(/^\d+\s*-\s*/, '')             // drop leading "1000 - "
    .replace(/\s*-\s*[A-Z]{2,8}$/, '')      // drop trailing " - TTC"
    .trim();
}

/**
 * Build the `title` field for an ERPNext Journal Entry (or any from→to ledger move).
 * Without this, ERPNext defaults the title to the first account name
 * (e.g. "5223 - Miscellaneous Expenses - TTC") — unhelpful in list views.
 *
 * Format: "<From>(<CUR>) to <To>(<CUR>)" — money flows source → destination.
 * Per-side currency is shown so multi-currency moves are unambiguous, e.g.
 * "Jameel Crest Gems(USD) to Cash(THB)" when a USD invoice is settled in THB cash.
 *
 *   Expense:   from = cash/bank/card wallet, to = expense category
 *   Income:    from = revenue category,      to = cash/bank/card wallet
 *   Transfer:  from = source wallet,         to = destination wallet
 *   Payment:   from = AR/AP party,           to = cash/bank/card wallet (or reverse)
 *
 * `currency` is the convenience arg when both sides match. Pass `fromCurrency`
 * and/or `toCurrency` to override per side.
 */
function buildJournalTitle({ currency, fromCurrency, toCurrency, fromAccount, toAccount }) {
  const from = friendlyAccountName(fromAccount) || 'Unknown';
  const to = friendlyAccountName(toAccount) || 'Unknown';
  const fc = fromCurrency || currency;
  const tc = toCurrency || currency;
  const fcTag = fc ? `(${fc})` : '';
  const tcTag = tc ? `(${tc})` : '';
  return `${from}${fcTag} to ${to}${tcTag}`.slice(0, 140);
}

/**
 * Resolve (or auto-create) a Receivable / Payable account in the given currency.
 * ERPNext rejects an invoice where the document currency doesn't match the
 * party account currency. For a multi-currency setup we need one Debtors /
 * Creditors leaf account per currency. The standard pattern:
 *
 *   Accounts Receivable (group)
 *     ├── Debtors          (THB, leaf)        <- company default
 *     ├── Debtors USD      (USD, leaf)        <- auto-created on first USD invoice
 *     └── Debtors EUR      (EUR, leaf)        <- etc.
 *
 * Per-process memo so repeated calls in the same run are cheap.
 *
 *   accountType: 'Receivable' | 'Payable'
 *   currency:    'USD' | 'THB' | …
 *   returns:     ERPNext account name (e.g. "Debtors USD - TTC")
 */
const _partyAccountCache = new Map();
async function resolvePartyAccount(erp, accountType, currency) {
  const cacheKey = `${erp.company}|${accountType}|${currency}`;
  if (_partyAccountCache.has(cacheKey)) return _partyAccountCache.get(cacheKey);

  // 1. Existing leaf account in this currency?
  const existing = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['account_type', '=', accountType],
      ['account_currency', '=', currency],
      ['is_group', '=', 0],
    ],
    fields: ['name'],
    limit: 1,
  });
  if (existing.data && existing.data.length > 0) {
    _partyAccountCache.set(cacheKey, existing.data[0].name);
    return existing.data[0].name;
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
  const result = await erp.createAccount({
    account_name: accountName,
    parent_account: parentAccount,
    account_type: accountType,
    account_currency: currency,
  });
  const erpName = result.data?.name;
  console.log(
    `• [erp-sync] [${ts()}] created ${accountType} account in ERPNext: ${erpName} (currency=${currency})`
  );
  _partyAccountCache.set(cacheKey, erpName);
  return erpName;
}

/**
 * Make sure a generic catch-all Item exists in ERPNext for use as the line-item placeholder
 * on invoices. ERPNext requires every invoice line to reference an Item — but for
 * service-style or one-off product sales/purchases we don't want to create an Item per gemstone.
 * The actual product description goes in the line's `description` field.
 *
 *   kind: 'sale' → GEN-SALE, 'purchase' → GEN-PURCHASE
 *
 * Per-process memo so we don't hit the API repeatedly.
 */
const GENERIC_ITEMS = {
  sale: { item_code: 'GEN-SALE', item_name: 'Generic Sale', is_sales_item: 1, is_purchase_item: 0,
    description: 'Default item used by bot for sales line items' },
  purchase: { item_code: 'GEN-PURCHASE', item_name: 'Generic Purchase', is_sales_item: 0, is_purchase_item: 1,
    description: 'Default item used by bot for purchase line items' },
};
const _itemEnsured = new Set();
async function ensureGenericItem(erp, kind = 'sale') {
  const spec = GENERIC_ITEMS[kind];
  if (_itemEnsured.has(spec.item_code)) return spec.item_code;

  try {
    await erp.getResource('Item', spec.item_code);
    _itemEnsured.add(spec.item_code);
    return spec.item_code;
  } catch (err) {
    if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) throw err;
  }

  await erp.createResource('Item', {
    ...spec,
    item_group: 'All Item Groups',
    stock_uom: 'Nos',
    is_stock_item: 0,
  });

  _itemEnsured.add(spec.item_code);
  console.log(`• [erp-sync] [${ts()}] created Item ${spec.item_code} in ERPNext`);
  return spec.item_code;
}

/** due_date from explicit date, else payment_terms ('net_30') + posting date, else posting date. */
function computeDueDate(draft) {
  if (draft.due_date) return draft.due_date;
  const postingDate = draft.transaction_date;
  if (typeof draft.payment_terms === 'string' && draft.payment_terms.startsWith('net_')) {
    const days = parseInt(draft.payment_terms.slice(4), 10);
    if (!isNaN(days)) {
      const d = new Date(`${postingDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    }
  }
  return postingDate;
}

/**
 * Exchange rate tx currency → company currency. 1 when they match.
 * Throws if a foreign-currency draft has no rate (request_confirmation should have caught it).
 */
function txRate(user, draft) {
  if (draft.currency === companyCurrency(user)) return 1;
  const r = Number(draft.exchange_rate);
  if (!r || r <= 0) {
    throw new Error(`no exchange rate for ${draft.currency}→${companyCurrency(user)}; call fetch_exchange_rate first`);
  }
  return r;
}

module.exports = {
  ERP_CODE_MAP,
  ts,
  round2,
  companyCurrency,
  resolveErpAccount,
  getAccountCurrency,
  friendlyAccountName,
  buildJournalTitle,
  resolvePartyAccount,
  ensureGenericItem,
  computeDueDate,
  txRate,
};
