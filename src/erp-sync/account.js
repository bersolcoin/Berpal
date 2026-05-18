/**
 * Resolve an ERPNext account name from our internal category code.
 *
 * ERPNext's chart-of-accounts numbering varies wildly by country
 * (Australia, India, US, etc. each have their own scheme), so we can't
 * rely on hardcoded code prefixes. Instead we resolve by the
 * standardized fields:
 *
 *   account_type  — Cash, Bank, Credit Card, Receivable, Payable,
 *                   Cost of Goods Sold, Tax, ...  (standardized)
 *   root_type     — Asset, Liability, Equity, Income, Expense
 *                   (always present)
 *
 * Each of our internal codes maps to a resolver function that returns
 * the first matching ERPNext account for the user's Company. Income /
 * expense category codes also try a name-keyword match first (so
 * "Sales Revenue" lands on an account containing "Sales") before
 * falling back to any leaf with the right root_type.
 *
 * Cache strategy: same as before — once resolved, the (user, code,
 * currency) → erpnext_account_name pair is stored in account_cache PG.
 * Wipe the cache row to force a re-lookup after CoA changes.
 */

const { query } = require('../db');
const { ts } = require('../log');

/**
 * Each code → an array of resolution attempts. Each attempt returns the
 * filters (and optional name-keyword preference) to feed listAccounts.
 * The first attempt that yields a leaf wins.
 *
 * Order matters — more specific attempts first, broader fallback last.
 */
const CODE_RESOLVERS = {
  // ── Assets ────────────────────────────────────────────────────────
  '1000': [{ account_type: 'Cash' }],
  '1100': [{ account_type: 'Bank' }],
  '1200': [{ account_type: 'Receivable' }],
  '1300': [{ root_type: 'Asset', namePrefer: ['Prepaid', 'Prepayment'] }],
  '1400': [{ root_type: 'Asset', namePrefer: ['Other Receivable', 'Other Asset'] }],

  // ── Liabilities ───────────────────────────────────────────────────
  '2000': [{ account_type: 'Payable' }],
  '2100': [{ account_type: 'Credit Card' }],
  '2200': [{ root_type: 'Liability', namePrefer: ['Other Payable', 'Other Liability'] }],

  // ── Equity ────────────────────────────────────────────────────────
  '3000': [{ root_type: 'Equity', namePrefer: ['Capital', "Owner's Equity", 'Owners Equity'] }],
  '3100': [{ root_type: 'Equity', namePrefer: ['Retained', 'Retained Earnings'] }],
  '3200': [{ root_type: 'Equity', namePrefer: ['Opening', 'Opening Balance Equity'] }],

  // ── Income ────────────────────────────────────────────────────────
  '4000': [{ root_type: 'Income', namePrefer: ['Sales', 'Revenue'] }],
  '4100': [{ root_type: 'Income', namePrefer: ['Service', 'Consulting', 'Fees'] }],
  '4900': [{ root_type: 'Income', namePrefer: ['Other Income', 'Interest', 'Misc'] }, { root_type: 'Income' }],

  // ── COGS ──────────────────────────────────────────────────────────
  '5000': [{ account_type: 'Cost of Goods Sold' }, { root_type: 'Expense', namePrefer: ['Cost of Goods', 'COGS'] }],

  // ── Expenses ──────────────────────────────────────────────────────
  '5100': [{ root_type: 'Expense', namePrefer: ['Meals', 'Entertainment'] }],
  '5200': [{ root_type: 'Expense', namePrefer: ['Travel'] }],
  '5210': [{ root_type: 'Expense', namePrefer: ['Vehicle', 'Fuel', 'Travel'] }],
  '5300': [{ root_type: 'Expense', namePrefer: ['Office', 'Supplies', 'Stationery'] }],
  '5350': [{ root_type: 'Expense', namePrefer: ['Insurance'] }],
  '5400': [{ root_type: 'Expense', namePrefer: ['Rent'] }],
  '5500': [{ root_type: 'Expense', namePrefer: ['Utilities', 'Electricity'] }],
  '5550': [{ root_type: 'Expense', namePrefer: ['Telephone', 'Internet', 'Communication'] }],
  '5600': [{ root_type: 'Expense', namePrefer: ['Software', 'Subscription'] }],
  '5700': [{ root_type: 'Expense', namePrefer: ['Professional', 'Legal', 'Consulting'] }],
  '5800': [{ root_type: 'Expense', namePrefer: ['Marketing', 'Advertising'] }],
  '5900': [{ root_type: 'Expense', namePrefer: ['Other', 'Misc'] }, { root_type: 'Expense' }],
  '5950': [{ root_type: 'Expense', namePrefer: ['Bank Charges', 'Bank Fee', 'Bank'] }],
};

/**
 * Try one resolution attempt. Returns the ERPNext account name or null.
 */
async function tryAttempt(erp, attempt) {
  const filters = [
    ['company', '=', erp.company],
    ['is_group', '=', 0],
    ['disabled', '=', 0],
  ];
  if (attempt.account_type) filters.push(['account_type', '=', attempt.account_type]);
  if (attempt.root_type) filters.push(['root_type', '=', attempt.root_type]);

  const r = await erp.listAccounts({ filters, limit: 100 });
  const accounts = r.data || [];
  if (accounts.length === 0) return null;

  // Name-keyword preference: pick the first account whose name contains
  // any of the preferred keywords. Falls back to the first account.
  if (attempt.namePrefer?.length) {
    for (const kw of attempt.namePrefer) {
      const hit = accounts.find((a) =>
        (a.account_name || '').toLowerCase().includes(kw.toLowerCase()) ||
        (a.name || '').toLowerCase().includes(kw.toLowerCase())
      );
      if (hit) return hit.name;
    }
  }
  return accounts[0].name;
}

async function resolveErpAccount(user, erp, ourCode, currency = null) {
  const cur = currency || user.reporting_currency || 'THB';

  // Cache hit?
  const cached = await query(
    `SELECT erpnext_account_name FROM account_cache
     WHERE user_id = $1 AND name = $2 AND currency = $3 AND is_active = 1
     LIMIT 1`,
    [user.id, ourCode, cur]
  );
  if (cached.rowCount > 0 && cached.rows[0].erpnext_account_name) {
    return cached.rows[0].erpnext_account_name;
  }

  const attempts = CODE_RESOLVERS[ourCode];
  if (!attempts) {
    console.warn(`× [account] [${ts()}] no resolver for code "${ourCode}"`);
    return null;
  }

  let erpName = null;
  for (const attempt of attempts) {
    erpName = await tryAttempt(erp, attempt);
    if (erpName) break;
  }
  if (!erpName) {
    console.warn(
      `× [account] [${ts()}] could not resolve code "${ourCode}" for company "${erp.company}" ` +
        `(tried ${attempts.length} attempt${attempts.length === 1 ? '' : 's'})`
    );
    return null;
  }

  // Write to cache (idempotent via ON CONFLICT)
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

  console.log(`• [account] [${ts()}] resolved ${ourCode}/${cur} = "${erpName}"`);
  return erpName;
}

module.exports = { resolveErpAccount, CODE_RESOLVERS };
