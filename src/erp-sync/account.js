/**
 * Resolve an ERPNext account name from our internal category code.
 *
 * Why a mapping exists: ERPNext's "Standard with Numbers" CoA template uses
 * different codes than the codes we expose to the LLM (which were designed
 * pre-pivot, before we knew we'd back onto ERPNext). Rather than break the
 * LLM-facing API, we translate our codes to ERPNext codes here.
 *
 * Cache strategy: `account_cache` table in Postgres (persists across restarts,
 * shared across instances).
 *   1. Look up cache row (user_id, name=ourCode, currency).
 *   2. Hit → return ERPNext account name immediately. No API call.
 *   3. Miss → query ERPNext for the account, write to cache, return.
 *
 * Manual refresh: just DELETE rows from account_cache for the user.
 */

const { query } = require('../db');
const { ts } = require('../log');

// Maps OUR internal category code → ERPNext account code prefix.
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
  // (1100 Bank requires picking a specific bank account; handled via wallet picker)
  '1200': '1310', // Accounts Receivable → Debtors
  // Liabilities
  '2000': '2110', // Accounts Payable → Creditors
  // Equity
  '3000': '3100', // Owner's Equity → Capital Stock
  '3100': '3400', // Retained Earnings
  '3200': '3300', // Opening Balance Equity
};

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

  // Cache miss — query ERPNext
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

  console.log(`• [conversation] [${ts()}] account_cache miss → wrote ${ourCode}/${cur} = "${erpName}"`);
  return erpName;
}

module.exports = { resolveErpAccount, ERP_CODE_MAP };
