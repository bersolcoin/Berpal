const { query } = require('./db');

// Parent codes considered "money on hand" — what shows up in "how much do I have" queries.
const CASH_BANK_PARENTS = ['1000', '1100']; // 1000 Cash, 1100 Bank — Primary
const CARD_PARENTS = ['2100']; // 2100 Credit Card — liability

async function listUserAccounts(userId, { parentCodes = null, currency = null } = {}) {
  const conditions = ['user_id = $1', 'is_active = 1'];
  const params = [userId];
  let p = 1;

  if (parentCodes && parentCodes.length > 0) {
    const placeholders = parentCodes.map(() => `$${++p}`).join(',');
    conditions.push(`parent_code IN (${placeholders})`);
    params.push(...parentCodes);
  }
  if (currency) {
    p++;
    conditions.push(`currency = $${p}`);
    params.push(String(currency).toUpperCase());
  }

  const result = await query(
    `SELECT id, code, name, type, parent_code, currency, external_id_erpnext
     FROM chart_of_accounts
     WHERE ${conditions.join(' AND ')}
     ORDER BY parent_code, name`,
    params
  );
  return result.rows;
}

async function createAccount(userId, { name, parent_code, currency, external_id_erpnext = null }) {
  if (!name || !parent_code || !currency) {
    return { error: 'name, parent_code, and currency are all required' };
  }

  // Idempotency: if a wallet with the same name + currency + parent already exists for this
  // user, return it instead of creating a duplicate. Match name case-insensitively.
  const dupRes = await query(
    `SELECT id, code, name, type, parent_code, currency
     FROM chart_of_accounts
     WHERE user_id = $1
       AND parent_code = $2
       AND currency = $3
       AND LOWER(name) = LOWER($4)
       AND is_active = 1
     LIMIT 1`,
    [userId, parent_code, String(currency).toUpperCase(), name]
  );
  if (dupRes.rowCount > 0) {
    return { account: dupRes.rows[0], existed: true };
  }

  // Look up the parent template to derive type and validate
  const parentRes = await query(
    `SELECT type, name AS parent_name FROM chart_of_accounts
     WHERE code = $1 AND user_id IS NULL LIMIT 1`,
    [parent_code]
  );
  if (parentRes.rowCount === 0) {
    return { error: `unknown parent_code "${parent_code}"` };
  }
  const { type } = parentRes.rows[0];

  // Auto-generate a per-user code: "<parent>-<seq>" e.g. 1100-001
  const existingRes = await query(
    `SELECT code FROM chart_of_accounts WHERE user_id = $1 AND parent_code = $2`,
    [userId, parent_code]
  );
  const seq = existingRes.rowCount + 1;
  const code = `${parent_code}-${String(seq).padStart(3, '0')}`;

  const now = new Date().toISOString();
  const insertRes = await query(
    `INSERT INTO chart_of_accounts
       (user_id, code, name, type, parent_code, currency, external_id_erpnext, is_active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
     RETURNING id, code, name, type, parent_code, currency`,
    [userId, code, name, type, parent_code, String(currency).toUpperCase(), external_id_erpnext, now]
  );

  return { account: insertRes.rows[0], existed: false };
}

/**
 * Cash + bank balance per account, plus per-currency totals.
 * Sums signed amounts: income → +, expense → -.
 * Excludes invoice_issued / bill_received (they hit AR/AP, not cash).
 * Only counts transactions with payment_account_id set (i.e. linked to a user account).
 */
async function getCashBankBalance(userId) {
  const accounts = await listUserAccounts(userId, { parentCodes: CASH_BANK_PARENTS });

  if (accounts.length === 0) {
    return {
      accounts: [],
      totals_by_currency: [],
      message: 'no_accounts',
    };
  }

  // Three contributions to a wallet's balance:
  //   1. payment_account_id = wallet AND direction in (income/expense): standard +/- of amount.
  //      For direction='transfer', this side is the SOURCE → subtract.
  //   2. transfer_destination_account_id = wallet: this side is the DESTINATION → add.
  //   We compute (1) and (2) separately then sum, so a single transfer hits both wallets correctly.
  const balanceRes = await query(
    `WITH source_side AS (
       SELECT coa.id AS account_id,
              COALESCE(SUM(
                CASE
                  WHEN tx.direction = 'income'   THEN tx.amount
                  WHEN tx.direction = 'expense'  THEN -tx.amount
                  WHEN tx.direction = 'transfer' THEN -tx.amount
                  ELSE 0
                END
              ), 0) AS source_balance
       FROM chart_of_accounts coa
       LEFT JOIN transactions tx
         ON tx.payment_account_id = coa.id
         AND tx.transaction_type IN ('cash', 'payment', 'advance_given', 'advance_received')
       WHERE coa.user_id = $1
         AND coa.parent_code = ANY($2::text[])
         AND coa.is_active = 1
       GROUP BY coa.id
     ),
     dest_side AS (
       SELECT coa.id AS account_id,
              COALESCE(SUM(tx.amount), 0) AS dest_balance
       FROM chart_of_accounts coa
       LEFT JOIN transactions tx
         ON tx.transfer_destination_account_id = coa.id
         AND tx.direction = 'transfer'
         AND tx.transaction_type = 'cash'
       WHERE coa.user_id = $1
         AND coa.parent_code = ANY($2::text[])
         AND coa.is_active = 1
       GROUP BY coa.id
     )
     SELECT
       coa.id AS account_id,
       coa.name AS account_name,
       coa.currency AS account_currency,
       coa.parent_code,
       (COALESCE(s.source_balance, 0) + COALESCE(d.dest_balance, 0)) AS balance
     FROM chart_of_accounts coa
     LEFT JOIN source_side s ON s.account_id = coa.id
     LEFT JOIN dest_side d ON d.account_id = coa.id
     WHERE coa.user_id = $1
       AND coa.parent_code = ANY($2::text[])
       AND coa.is_active = 1
     ORDER BY coa.parent_code, coa.name`,
    [userId, CASH_BANK_PARENTS]
  );

  const accountRows = balanceRes.rows.map((r) => ({
    account_id: r.account_id,
    account_name: r.account_name,
    currency: r.account_currency,
    parent_code: r.parent_code,
    balance: parseFloat(r.balance) || 0,
  }));

  // Per-currency totals
  const byCurrency = {};
  for (const r of accountRows) {
    const c = r.currency || 'UNKNOWN';
    byCurrency[c] = (byCurrency[c] || 0) + r.balance;
  }
  const totals_by_currency = Object.entries(byCurrency).map(([currency, total]) => ({
    currency,
    total,
  }));

  return {
    accounts: accountRows,
    totals_by_currency,
  };
}

/**
 * Resolve which user account to link a new transaction to.
 * Used by transactions.save to auto-link payment_account_id.
 * Returns { id } if exactly one match, null otherwise (caller asks user to pick).
 */
async function resolveSingleMatch(userId, parent_code, currency) {
  if (!parent_code || !currency) return null;
  const accounts = await listUserAccounts(userId, {
    parentCodes: [parent_code],
    currency,
  });
  if (accounts.length === 1) return accounts[0];
  return null;
}

module.exports = {
  listUserAccounts,
  createAccount,
  getCashBankBalance,
  resolveSingleMatch,
  CASH_BANK_PARENTS,
  CARD_PARENTS,
};
